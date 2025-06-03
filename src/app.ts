import * as path from "node:path";
import * as apprunner from "@aws-cdk/aws-apprunner-alpha";
import { bedrock } from "@cdklabs/generative-ai-cdk-constructs";
import * as cdk from "aws-cdk-lib";
import { FoundationModelIdentifier } from "aws-cdk-lib/aws-bedrock";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";

const app = new cdk.App();
const stack = new cdk.Stack(app, "PlayOpenWebuiCognitoBedrock");

// User pool
const userPool = new cognito.UserPool(stack, "Default", {
	selfSignUpEnabled: false,
	signInAliases: {
		username: false,
		email: true,
	},
	passwordPolicy: {
		tempPasswordValidity: cdk.Duration.days(7),
		requireLowercase: false,
		requireUppercase: false,
		requireDigits: false,
		requireSymbols: false,
		minLength: 8,
	},
	email: cognito.UserPoolEmail.withCognito(),
	accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
	deviceTracking: {
		challengeRequiredOnNewDevice: true,
		deviceOnlyRememberedOnUserPrompt: true,
	},

	removalPolicy: cdk.RemovalPolicy.DESTROY,
	deletionProtection: false,
});
userPool.addDomain("CustomDomain", {
	cognitoDomain: {
		domainPrefix: "yamatatsu-open-webui-test",
	},
});
const userPoolClient = userPool.addClient("UserPoolClient", {
	generateSecret: true,
	oAuth: {
		callbackUrls: [
			"http://localhost:8080/oauth/oidc/callback",
			// TODO: Custom Domain を使わない場合、APP Runnerローンチ後にURLが決定する。paramとして持つか。
			"https://xxxxx.ap-northeast-1.awsapprunner.com/oauth/oidc/callback",
		],
		logoutUrls: [
			"http://localhost:8080",
			"https://xxxxx.ap-northeast-1.awsapprunner.com/",
		],
		flows: { authorizationCodeGrant: true },
		scopes: [
			cdk.aws_cognito.OAuthScope.OPENID,
			cdk.aws_cognito.OAuthScope.EMAIL,
			cdk.aws_cognito.OAuthScope.PROFILE,
		],
	},
	authFlows: {
		userSrp: true,
		user: true,
		userPassword: true,
	},
	preventUserExistenceErrors: true,
	supportedIdentityProviders: [
		cdk.aws_cognito.UserPoolClientIdentityProvider.COGNITO,
	],
});

const openWebUIStorage = new s3.Bucket(stack, "OpenWebUIStorage", {
	bucketName: `open-webui-storage-${stack.account}-${stack.region}`,
	blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
	encryption: s3.BucketEncryption.S3_MANAGED,
	enforceSSL: true,
	// 削除されては困るならコメントアウトして再デプロイ
	removalPolicy: cdk.RemovalPolicy.DESTROY,
	autoDeleteObjects: true,
});

const vpc = new ec2.Vpc(stack, "Vpc", {
	// natGateways: 0,
	natGateways: 1,
	natGatewayProvider: ec2.NatProvider.instanceV2({
		instanceType: ec2.InstanceType.of(
			ec2.InstanceClass.T4G,
			ec2.InstanceSize.NANO,
		),
	}),
});

const liteLLMService = new apprunner.Service(stack, "LiteLLMService", {
	// vpcConnector,
	cpu: apprunner.Cpu.ONE_VCPU,
	memory: apprunner.Memory.TWO_GB,
	source: apprunner.Source.fromAsset({
		asset: new assets.DockerImageAsset(stack, "LiteLLMImageAssets", {
			directory: "litellm",
			platform: assets.Platform.LINUX_AMD64,
		}),
		imageConfiguration: {
			port: 4000,
			environmentVariables: {
				JSON_LOGS: "true",
				// デバッグ
				LITELLM_LOG: "DEBUG",
			},
		},
	}),
	isPubliclyAccessible: false,
});
liteLLMService.addToRolePolicy(
	new iam.PolicyStatement({
		actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
		resources: ["*"],
	}),
);
const interfaceVpcEndpoint = new ec2.InterfaceVpcEndpoint(
	stack,
	"MyVpcEndpoint",
	{
		vpc,
		service: ec2.InterfaceVpcEndpointAwsService.APP_RUNNER_REQUESTS,
		privateDnsEnabled: false,
	},
);
new apprunner.VpcIngressConnection(stack, "VpcIngressConnection", {
	vpc,
	interfaceVpcEndpoint,
	service: liteLLMService,
});

const vpcConnector = new apprunner.VpcConnector(stack, "VpcConnector", {
	vpc,
	vpcSubnets: vpc.selectSubnets({
		subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
	}),
});
new apprunner.Service(stack, "OpenWebUIService", {
	vpcConnector,
	cpu: apprunner.Cpu.ONE_VCPU,
	memory: apprunner.Memory.TWO_GB,
	source: apprunner.Source.fromAsset({
		asset: new assets.DockerImageAsset(stack, "ImageAssets", {
			directory: "open-webui",
			platform: assets.Platform.LINUX_AMD64,
		}),
		imageConfiguration: {
			port: 8080,
			environmentVariables: {
				WEBUI_SECRET_KEY: "",
				ENABLE_OLLAMA_API: "false",
				// TODO: 値渡しする
				OPENAI_API_BASE_URL:
					"https://dqtazwtytw.ap-northeast-1.awsapprunner.com",
				OPENAI_API_KEY: "sk-12345",

				// Cognito 認証
				ENABLE_LOGIN_FORM: "false",
				ENABLE_OAUTH_SIGNUP: "true",
				WEBUI_URL: "/",
				OAUTH_CLIENT_ID: userPoolClient.userPoolClientId,
				// NOTE: secretsがコンソール上に露出するのを避けたい場合は、environmentSecretsを使う。
				OAUTH_CLIENT_SECRET: userPoolClient.userPoolClientSecret.unsafeUnwrap(),
				OPENID_PROVIDER_URL: `${userPool.userPoolProviderUrl}/.well-known/openid-configuration`,

				// SQLiteをS3に保存する場合
				// S3_ACCESS_KEY_ID: 'ABC123',
				// S3_SECRET_ACCESS_KEY: 'スーパーシークレット',
				// S3_ENDPOINT_URL: 'https://s3.us-east-1.amazonaws.com',
				// S3_REGION_NAME: stack.region,
				// S3_BUCKET_NAME: openWebUIStorage.bucketName,

				// デバッグ
				GLOBAL_LOG_LEVEL: "DEBUG",
			},
			environmentSecrets: {
				// NOTE: secretsがコンソール上に露出するのを避けたい場合は、手動でSecure String Parameterなどに設定してここにセットする。
			},
		},
	}),
});
