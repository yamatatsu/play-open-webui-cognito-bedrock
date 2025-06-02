import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import { bedrock } from '@cdklabs/generative-ai-cdk-constructs';
import * as path from "path";

const app = new cdk.App();
const stack = new cdk.Stack(app,'PlayOpenWebuiCognitoBedrock');


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
		domainPrefix: 'yamatatsu-open-webui-test',
	}
});
userPool.addClient("UserPoolClient", {
	generateSecret: true,
	oAuth: {
		callbackUrls: ['http://localhost:8080/oauth/oidc/callback'],
		logoutUrls: ['http://localhost:8080'],
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
	supportedIdentityProviders: [cdk.aws_cognito.UserPoolClientIdentityProvider.COGNITO],
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
	natGateways: 0
});

const cluster = new ecs.Cluster(stack, "Cluster", {
	vpc,
});


const taskDef = new ecs.FargateTaskDefinition(
	stack,
	"TaskDefinition",
	{
		executionRole: executionRole,
		taskRole: serviceTaskRole,
		runtimePlatform: {
			cpuArchitecture: ecs.CpuArchitecture.X86_64,
		},
	},
);

new ecs.FargateService(stack, "Service", {
		cluster,
		vpcSubnets: {
			subnetType: ec2.SubnetType.PUBLIC,
		},
		taskDefinition: taskDefinition,
		desiredCount: 1,
		maxHealthyPercent: 100,
		minHealthyPercent: 0,
		circuitBreaker: {
			enable: true,
			rollback: true,
		},
	},
);