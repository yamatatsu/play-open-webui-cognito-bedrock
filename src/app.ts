import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";

const app = new cdk.App();
const stack = new cdk.Stack(app,'PlayOpenWebuiCognitoBedrock');

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