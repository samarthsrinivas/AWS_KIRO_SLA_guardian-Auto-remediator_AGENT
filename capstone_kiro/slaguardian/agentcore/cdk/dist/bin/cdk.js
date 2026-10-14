#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk_stack_1 = require("../lib/cdk-stack");
const agentcore_cdk_1 = require("@aws/agentcore-cdk");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const path = require("path");
const fs = require("fs");
function toEnvironment(target) {
    return {
        account: target.account,
        region: target.region,
    };
}
function sanitize(name) {
    return name.replace(/_/g, '-');
}
function toStackName(projectName, targetName) {
    return `AgentCore-${sanitize(projectName)}-${sanitize(targetName)}`;
}
async function main() {
    // Config root is parent of cdk/ directory. The CLI sets process.cwd() to agentcore/cdk/.
    const configRoot = path.resolve(process.cwd(), '..');
    const configIO = new agentcore_cdk_1.ConfigIO({ baseDir: configRoot });
    const spec = await configIO.readProjectSpec();
    const targets = await configIO.readAWSDeploymentTargets();
    // The vended CDK project compiles against the published @aws/agentcore-cdk
    // schema type, which may lag the CLI's own AgentCoreProjectSpec (e.g. payments,
    // harnesses, gateway fields). Cast once so those fields are reachable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const specAny = spec;
    // Extract MCP configuration from project spec.
    // Gateway fields are stored in agentcore.json but may not yet be on the
    const mcpSpec = specAny.agentCoreGateways?.length
        ? {
            agentCoreGateways: specAny.agentCoreGateways,
            mcpRuntimeTools: specAny.mcpRuntimeTools,
            unassignedTargets: specAny.unassignedTargets,
        }
        : undefined;
    // Read deployed state for credential ARNs (populated by pre-deploy identity setup)
    let deployedState;
    try {
        deployedState = JSON.parse(fs.readFileSync(path.join(configRoot, '.cli', 'deployed-state.json'), 'utf8'));
    }
    catch {
        // Deployed state may not exist on first deploy
    }
    if (targets.length === 0) {
        throw new Error('No deployment targets configured. Please define targets in agentcore/aws-targets.json');
    }
    // Read harness configs: the full validated spec drives the CFN resource; the
    // role-scoped fields drive the IAM role + container build.
    const projectRoot = path.resolve(configRoot, '..');
    // Read non-S3 KB connector-config files and pass their parsed contents to the
    // L3 verbatim. The L3 does not read files; it expects the parsed
    // connectorParameters keyed by the data source's connectorConfigFile path.
    const connectorParametersByFile = {};
    for (const kb of specAny.knowledgeBases ?? []) {
        for (const ds of kb.dataSources ?? []) {
            if (ds.type !== 'S3' && ds.connectorConfigFile) {
                const abs = path.resolve(projectRoot, ds.connectorConfigFile);
                try {
                    connectorParametersByFile[ds.connectorConfigFile] = JSON.parse(fs.readFileSync(abs, 'utf-8'));
                }
                catch (err) {
                    throw new Error(`Could not read connector config '${ds.connectorConfigFile}' for knowledge base '${kb.name}' at ${abs}: ${err instanceof Error ? err.message : err}`);
                }
            }
        }
    }
    // Synthesize an AWS::BedrockAgentCore::Harness resource for each harness entry in the spec.
    const harnessConfigs = [];
    for (const entry of specAny.harnesses ?? []) {
        const harnessDir = path.resolve(projectRoot, entry.path);
        const harnessPath = path.resolve(harnessDir, 'harness.json');
        try {
            const harnessSpec = agentcore_cdk_1.HarnessSpecSchema.parse(JSON.parse(fs.readFileSync(harnessPath, 'utf-8')));
            harnessConfigs.push({
                name: entry.name,
                executionRoleArn: harnessSpec.executionRoleArn,
                // Only an `existing` memory ref carries a name to wire IAM against; managed memory is
                // owned by the harness (no sibling) and disabled has none — both resolve to undefined.
                memoryName: harnessSpec.memory?.mode === 'existing' ? harnessSpec.memory.name : undefined,
                containerUri: harnessSpec.containerUri,
                hasDockerfile: !!harnessSpec.dockerfile,
                dockerfile: harnessSpec.dockerfile,
                codeLocation: harnessSpec.dockerfile ? harnessDir : undefined,
                tools: harnessSpec.tools,
                skills: harnessSpec.skills,
                apiKeyArn: harnessSpec.model?.apiKeyArn,
                efsAccessPoints: harnessSpec.efsAccessPoints,
                s3AccessPoints: harnessSpec.s3AccessPoints,
                apiFormat: harnessSpec.model?.apiFormat,
                // Full spec + dir drive the AWS::BedrockAgentCore::Harness CFN resource.
                spec: harnessSpec,
                harnessDir,
            });
        }
        catch (err) {
            throw new Error(`Could not read harness.json for "${entry.name}" at ${harnessPath}: ${err instanceof Error ? err.message : err}`);
        }
    }
    const app = new aws_cdk_lib_1.App();
    for (const target of targets) {
        const env = toEnvironment(target);
        const stackName = toStackName(spec.name, target.name);
        // Extract credentials from deployed state for this target
        const targetState = deployedState?.targets;
        const targetResources = targetState?.[target.name]?.resources;
        const credentials = targetResources?.credentials;
        // Payment credential provider ARNs live in the same credentials map as identity credentials
        const paymentCredentials = credentials;
        const paymentSpec = specAny.payments?.length
            ? specAny.payments.map((p) => ({
                name: p.name,
                description: p.description,
                authorizerType: p.authorizerType,
                authorizerConfiguration: p.authorizerConfiguration,
                autoPayment: p.autoPayment,
                paymentToolAllowlist: p.paymentToolAllowlist,
                networkPreferences: p.networkPreferences,
                connectors: p.connectors.map(c => {
                    if (c.provisionMode === 'QUICK_CREATE') {
                        return {
                            name: c.name,
                            provider: 'CoinbaseCDP',
                            provisionMode: 'QUICK_CREATE',
                        };
                    }
                    if (!c.credentialName) {
                        throw new Error(`Manual payment connector "${c.name}" on manager "${p.name}" is missing its credential name.`);
                    }
                    const credentialProviderArn = paymentCredentials?.[c.credentialName]?.credentialProviderArn;
                    if (!credentialProviderArn) {
                        // Fail fast with an actionable message rather than passing an empty
                        // ARN that fails opaquely server-side at CreatePaymentConnector.
                        throw new Error(`Payment connector "${c.name}" on manager "${p.name}" references credential ` +
                            `"${c.credentialName}", but no deployed credential provider was found for it. ` +
                            `Run \`agentcore deploy\` so the credential provider is created first.`);
                    }
                    return {
                        name: c.name,
                        provider: c.provider,
                        ...(c.provisionMode && { provisionMode: c.provisionMode }),
                        credentialName: c.credentialName,
                        credentialProviderArn,
                    };
                }),
            }))
            : undefined;
        new cdk_stack_1.AgentCoreStack(app, stackName, {
            spec,
            mcpSpec,
            credentials,
            connectorParametersByFile,
            harnesses: harnessConfigs.length > 0 ? harnessConfigs : undefined,
            paymentSpec,
            env,
            description: `AgentCore stack for ${spec.name} deployed to ${target.name} (${target.region})`,
            tags: {
                'agentcore:project-name': spec.name,
                'agentcore:target-name': target.name,
            },
        });
    }
    app.synth();
}
main().catch((error) => {
    console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vYmluL2Nkay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSxnREFBc0U7QUFDdEUsc0RBQTJGO0FBQzNGLDZDQUFvRDtBQUNwRCw2QkFBNkI7QUFDN0IseUJBQXlCO0FBRXpCLFNBQVMsYUFBYSxDQUFDLE1BQTJCO0lBQ2hELE9BQU87UUFDTCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU87UUFDdkIsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNO0tBQ3RCLENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxRQUFRLENBQUMsSUFBWTtJQUM1QixPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxXQUFtQixFQUFFLFVBQWtCO0lBQzFELE9BQU8sYUFBYSxRQUFRLENBQUMsV0FBVyxDQUFDLElBQUksUUFBUSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFDdEUsQ0FBQztBQUVELEtBQUssVUFBVSxJQUFJO0lBQ2pCLHlGQUF5RjtJQUN6RixNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNyRCxNQUFNLFFBQVEsR0FBRyxJQUFJLHdCQUFRLENBQUMsRUFBRSxPQUFPLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztJQUV2RCxNQUFNLElBQUksR0FBRyxNQUFNLFFBQVEsQ0FBQyxlQUFlLEVBQUUsQ0FBQztJQUM5QyxNQUFNLE9BQU8sR0FBRyxNQUFNLFFBQVEsQ0FBQyx3QkFBd0IsRUFBRSxDQUFDO0lBRTFELDJFQUEyRTtJQUMzRSxnRkFBZ0Y7SUFDaEYsdUVBQXVFO0lBQ3ZFLDhEQUE4RDtJQUM5RCxNQUFNLE9BQU8sR0FBRyxJQUFXLENBQUM7SUFFNUIsK0NBQStDO0lBQy9DLHdFQUF3RTtJQUN4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QUFDLElBQUksZ0JBQWdCLE1BQU0sQ0FBQyxJQUFJLEtBQUssTUFBTSxDQUFDLE1BQU0sR0FBRztZQUM3RixJQUFJLEVBQUU7Z0JBQ0osd0JBQXdCLEVBQUUsSUFBSSxDQUFDLElBQUk7Z0JBQ25DLHVCQUF1QixFQUFFLE1BQU0sQ0FBQyxJQUFJO2FBQ3JDO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQztBQUNkLENBQUM7QUFFRCxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFjLEVBQUUsRUFBRTtJQUM5QixPQUFPLENBQUMsS0FBSyxDQUFDLGlDQUFpQyxFQUFFLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2pHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXG5pbXBvcnQgeyBBZ2VudENvcmVTdGFjaywgdHlwZSBIYXJuZXNzQ29uZmlnIH0gZnJvbSAnLi4vbGliL2Nkay1zdGFjayc7XG5pbXBvcnQgeyBDb25maWdJTywgSGFybmVzc1NwZWNTY2hlbWEsIHR5cGUgQXdzRGVwbG95bWVudFRhcmdldCB9IGZyb20gJ0Bhd3MvYWdlbnRjb3JlLWNkayc7XG5pbXBvcnQgeyBBcHAsIHR5cGUgRW52aXJvbm1lbnQgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuXG5mdW5jdGlvbiB0b0Vudmlyb25tZW50KHRhcmdldDogQXdzRGVwbG95bWVudFRhcmdldCk6IEVudmlyb25tZW50IHtcbiAgcmV0dXJuIHtcbiAgICBhY2NvdW50OiB0YXJnZXQuYWNjb3VudCxcbiAgICByZWdpb246IHRhcmdldC5yZWdpb24sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBuYW1lLnJlcGxhY2UoL18vZywgJy0nKTtcbn1cblxuZnVuY3Rpb24gdG9TdGFja05hbWUocHJvamVjdE5hbWU6IHN0cmluZywgdGFyZ2V0TmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBBZ2VudENvcmUtJHtzYW5pdGl6ZShwcm9qZWN0TmFtZSl9LSR7c2FuaXRpemUodGFyZ2V0TmFtZSl9YDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgLy8gQ29uZmlnIHJvb3QgaXMgcGFyZW50IG9mIGNkay8gZGlyZWN0b3J5LiBUaGUgQ0xJIHNldHMgcHJvY2Vzcy5jd2QoKSB0byBhZ2VudGNvcmUvY2RrLy5cbiAgY29uc3QgY29uZmlnUm9vdCA9IHBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCAnLi4nKTtcbiAgY29uc3QgY29uZmlnSU8gPSBuZXcgQ29uZmlnSU8oeyBiYXNlRGlyOiBjb25maWdSb290IH0pO1xuXG4gIGNvbnN0IHNwZWMgPSBhd2FpdCBjb25maWdJTy5yZWFkUHJvamVjdFNwZWMoKTtcbiAgY29uc3QgdGFyZ2V0cyA9IGF3YWl0IGNvbmZpZ0lPLnJlYWRBV1NEZXBsb3ltZW50VGFyZ2V0cygpO1xuXG4gIC8vIFRoZSB2ZW5kZWQgQ0RLIHByb2plY3QgY29tcGlsZXMgYWdhaW5zdCB0aGUgcHVibGlzaGVkIEBhd3MvYWdlbnRjb3JlLWNka1xuICAvLyBzY2hlbWEgdHlwZSwgd2hpY2ggbWF5IGxhZyB0aGUgQ0xJJ3Mgb3duIEFnZW50Q29yZVByb2plY3RTcGVjIChlLmcuIHBheW1lbnRzLFxuICAvLyBoYXJuZXNzZXMsIGdhdGV3YXkgZmllbGRzKS4gQ2FzdCBvbmNlIHNvIHRob3NlIGZpZWxkcyBhcmUgcmVhY2hhYmxlLlxuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICBjb25zdCBzcGVjQW55ID0gc3BlYyBhcyBhbnk7XG5cbiAgLy8gRXh0cmFjdCBNQ1AgY29uZmlndXJhdGlvbiBmcm9tIHByb2plY3Qgc3BlYy5cbiAgLy8gR2F0ZXdheSBmaWVsZHMgYXJlIHN0b3JlZCBpbiBhZ2VudGNvcmUuanNvbiBidXQgbWF5IG5vdCB5ZXQgYmUgb24gdGhlXG4gIGNvbnN0IG1jcFNwZWMgPSBzcGVjQW55LmFnZW50Q29yZUdhdGV3YXlzPy5sZW5ndGhcbiAgICA/IHtcbiAgICAgICAgYWdlbnRDb3JlR2F0ZXdheXM6IHNwZWNBbnkuYWdlbnRDb3JlR2F0ZXdheXMsXG4gICAgICAgIG1jcFJ1bnRpbWVUb29sczogc3BlY0FueS5tY3BSdW50aW1lVG9vbHMsXG4gICAgICAgIHVuYXNzaWduZWRUYXJnZXRzOiBzcGVjQW55LnVuYXNzaWduZWRUYXJnZXRzLFxuICAgICAgfVxuICAgIDogdW5kZWZpbmVkO1xuXG4gIC8vIFJlYWQgZGVwbG95ZWQgc3RhdGUgZm9yIGNyZWRlbnRpYWwgQVJOcyAocG9wdWxhdGVkIGJ5IHByZS1kZXBsb3kgaWRlbnRpdHkgc2V0dXApXG4gIGxldCBkZXBsb3llZFN0YXRlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBkZXBsb3llZFN0YXRlID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKGNvbmZpZ1Jvb3QsICcuY2xpJywgJ2RlcGxveWVkLXN0YXRlLmpzb24nKSwgJ3V0ZjgnKSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIERlcGxveWVkIHN0YXRlIG1heSBub3QgZXhpc3Qgb24gZmlyc3QgZGVwbG95XG4gIH1cblxuICBpZiAodGFyZ2V0cy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGRlcGxveW1lbnQgdGFyZ2V0cyBjb25maWd1cmVkLiBQbGVhc2UgZGVmaW5lIHRhcmdldHMgaW4gYWdlbnRjb3JlL2F3cy10YXJnZXRzLmpzb24nKTtcbiAgfVxuXG4gIC8vIFJlYWQgaGFybmVzcyBjb25maWdzOiB0aGUgZnVsbCB2YWxpZGF0ZWQgc3BlYyBkcml2ZXMgdGhlIENGTiByZXNvdXJjZTsgdGhlXG4gIC8vIHJvbGUtc2NvcGVkIGZpZWxkcyBkcml2ZSB0aGUgSUFNIHJvbGUgKyBjb250YWluZXIgYnVpbGQuXG4gIGNvbnN0IHByb2plY3RSb290ID0gcGF0aC5yZXNvbHZlKGNvbmZpZ1Jvb3QsICcuLicpO1xuXG4gIC8vIFJlYWQgbm9uLVMzIEtCIGNvbm5lY3Rvci1jb25maWcgZmlsZXMgYW5kIHBhc3MgdGhlaXIgcGFyc2VkIGNvbnRlbnRzIHRvIHRoZVxuICAvLyBMMyB2ZXJiYXRpbS4gVGhlIEwzIGRvZXMgbm90IHJlYWQgZmlsZXM7IGl0IGV4cGVjdHMgdGhlIHBhcnNlZFxuICAvLyBjb25uZWN0b3JQYXJhbWV0ZXJzIGtleWVkIGJ5IHRoZSBkYXRhIHNvdXJjZSdzIGNvbm5lY3RvckNvbmZpZ0ZpbGUgcGF0aC5cbiAgY29uc3QgY29ubmVjdG9yUGFyYW1ldGVyc0J5RmlsZTogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge307XG4gIGZvciAoY29uc3Qga2Igb2Ygc3BlY0FueS5rbm93bGVkZ2VCYXNlcyA/PyBbXSkge1xuICAgIGZvciAoY29uc3QgZHMgb2Yga2IuZGF0YVNvdXJjZXMgPz8gW10pIHtcbiAgICAgIGlmIChkcy50eXBlICE9PSAnUzMnICYmIGRzLmNvbm5lY3RvckNvbmZpZ0ZpbGUpIHtcbiAgICAgICAgY29uc3QgYWJzID0gcGF0aC5yZXNvbHZlKHByb2plY3RSb290LCBkcy5jb25uZWN0b3JDb25maWdGaWxlKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25uZWN0b3JQYXJhbWV0ZXJzQnlGaWxlW2RzLmNvbm5lY3RvckNvbmZpZ0ZpbGVdID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMoYWJzLCAndXRmLTgnKSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBDb3VsZCBub3QgcmVhZCBjb25uZWN0b3IgY29uZmlnICcke2RzLmNvbm5lY3RvckNvbmZpZ0ZpbGV9JyBmb3Iga25vd2xlZGdlIGJhc2UgJyR7a2IubmFtZX0nIGF0ICR7YWJzfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyfWBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gU3ludGhlc2l6ZSBhbiBBV1M6OkJlZHJvY2tBZ2VudENvcmU6Okhhcm5lc3MgcmVzb3VyY2UgZm9yIGVhY2ggaGFybmVzcyBlbnRyeSBpbiB0aGUgc3BlYy5cbiAgY29uc3QgaGFybmVzc0NvbmZpZ3M6IEhhcm5lc3NDb25maWdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNwZWNBbnkuaGFybmVzc2VzID8/IFtdKSB7XG4gICAgY29uc3QgaGFybmVzc0RpciA9IHBhdGgucmVzb2x2ZShwcm9qZWN0Um9vdCwgZW50cnkucGF0aCk7XG4gICAgY29uc3QgaGFybmVzc1BhdGggPSBwYXRoLnJlc29sdmUoaGFybmVzc0RpciwgJ2hhcm5lc3MuanNvbicpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBoYXJuZXNzU3BlYyA9IEhhcm5lc3NTcGVjU2NoZW1hLnBhcnNlKEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKGhhcm5lc3NQYXRoLCAndXRmLTgnKSkpO1xuICAgICAgaGFybmVzc0NvbmZpZ3MucHVzaCh7XG4gICAgICAgIG5hbWU6IGVudHJ5Lm5hbWUsXG4gICAgICAgIGV4ZWN1dGlvblJvbGVBcm46IGhhcm5lc3NTcGVjLmV4ZWN1dGlvblJvbGVBcm4sXG4gICAgICAgIC8vIE9ubHkgYW4gYGV4aXN0aW5nYCBtZW1vcnkgcmVmIGNhcnJpZXMgYSBuYW1lIHRvIHdpcmUgSUFNIGFnYWluc3Q7IG1hbmFnZWQgbWVtb3J5IGlzXG4gICAgICAgIC8vIG93bmVkIGJ5IHRoZSBoYXJuZXNzIChubyBzaWJsaW5nKSBhbmQgZGlzYWJsZWQgaGFzIG5vbmUg4oCUIGJvdGggcmVzb2x2ZSB0byB1bmRlZmluZWQuXG4gICAgICAgIG1lbW9yeU5hbWU6IGhhcm5lc3NTcGVjLm1lbW9yeT8ubW9kZSA9PT0gJ2V4aXN0aW5nJyA/IGhhcm5lc3NTcGVjLm1lbW9yeS5uYW1lIDogdW5kZWZpbmVkLFxuICAgICAgICBjb250YWluZXJVcmk6IGhhcm5lc3NTcGVjLmNvbnRhaW5lclVyaSxcbiAgICAgICAgaGFzRG9ja2VyZmlsZTogISFoYXJuZXNzU3BlYy5kb2NrZXJmaWxlLFxuICAgICAgICBkb2NrZXJmaWxlOiBoYXJuZXNzU3BlYy5kb2NrZXJmaWxlLFxuICAgICAgICBjb2RlTG9jYXRpb246IGhhcm5lc3NTcGVjLmRvY2tlcmZpbGUgPyBoYXJuZXNzRGlyIDogdW5kZWZpbmVkLFxuICAgICAgICB0b29sczogaGFybmVzc1NwZWMudG9vbHMsXG4gICAgICAgIHNraWxsczogaGFybmVzc1NwZWMuc2tpbGxzLFxuICAgICAgICBhcGlLZXlBcm46IGhhcm5lc3NTcGVjLm1vZGVsPy5hcGlLZXlBcm4sXG4gICAgICAgIGVmc0FjY2Vzc1BvaW50czogaGFybmVzc1NwZWMuZWZzQWNjZXNzUG9pbnRzLFxuICAgICAgICBzM0FjY2Vzc1BvaW50czogaGFybmVzc1NwZWMuczNBY2Nlc3NQb2ludHMsXG4gICAgICAgIGFwaUZvcm1hdDogaGFybmVzc1NwZWMubW9kZWw/LmFwaUZvcm1hdCxcbiAgICAgICAgLy8gRnVsbCBzcGVjICsgZGlyIGRyaXZlIHRoZSBBV1M6OkJlZHJvY2tBZ2VudENvcmU6Okhhcm5lc3MgQ0ZOIHJlc291cmNlLlxuICAgICAgICBzcGVjOiBoYXJuZXNzU3BlYyxcbiAgICAgICAgaGFybmVzc0RpcixcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQ291bGQgbm90IHJlYWQgaGFybmVzcy5qc29uIGZvciBcIiR7ZW50cnkubmFtZX1cIiBhdCAke2hhcm5lc3NQYXRofTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyfWBcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgYXBwID0gbmV3IEFwcCgpO1xuXG4gIGZvciAoY29uc3QgdGFyZ2V0IG9mIHRhcmdldHMpIHtcbiAgICBjb25zdCBlbnYgPSB0b0Vudmlyb25tZW50KHRhcmdldCk7XG4gICAgY29uc3Qgc3RhY2tOYW1lID0gdG9TdGFja05hbWUoc3BlYy5uYW1lLCB0YXJnZXQubmFtZSk7XG5cbiAgICAvLyBFeHRyYWN0IGNyZWRlbnRpYWxzIGZyb20gZGVwbG95ZWQgc3RhdGUgZm9yIHRoaXMgdGFyZ2V0XG4gICAgY29uc3QgdGFyZ2V0U3RhdGUgPSAoZGVwbG95ZWRTdGF0ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik/LnRhcmdldHMgYXNcbiAgICAgIFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCB0YXJnZXRSZXNvdXJjZXMgPSB0YXJnZXRTdGF0ZT8uW3RhcmdldC5uYW1lXT8ucmVzb3VyY2VzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNyZWRlbnRpYWxzID0gdGFyZ2V0UmVzb3VyY2VzPy5jcmVkZW50aWFscyBhc1xuICAgICAgUmVjb3JkPHN0cmluZywgeyBjcmVkZW50aWFsUHJvdmlkZXJBcm46IHN0cmluZzsgY2xpZW50U2VjcmV0QXJuPzogc3RyaW5nIH0+IHwgdW5kZWZpbmVkO1xuXG4gICAgLy8gUGF5bWVudCBjcmVkZW50aWFsIHByb3ZpZGVyIEFSTnMgbGl2ZSBpbiB0aGUgc2FtZSBjcmVkZW50aWFscyBtYXAgYXMgaWRlbnRpdHkgY3JlZGVudGlhbHNcbiAgICBjb25zdCBwYXltZW50Q3JlZGVudGlhbHMgPSBjcmVkZW50aWFscztcblxuICAgIGNvbnN0IHBheW1lbnRTcGVjID0gc3BlY0FueS5wYXltZW50cz8ubGVuZ3RoXG4gICAgICA/IHNwZWNBbnkucGF5bWVudHMubWFwKFxuICAgICAgICAgIChwOiB7XG4gICAgICAgICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICAgICAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICAgICAgICAgIGF1dGhvcml6ZXJUeXBlOiAnQVdTX0lBTScgfCAnQ1VTVE9NX0pXVCc7XG4gICAgICAgICAgICBhdXRob3JpemVyQ29uZmlndXJhdGlvbj86IHVua25vd247XG4gICAgICAgICAgICBhdXRvUGF5bWVudD86IGJvb2xlYW47XG4gICAgICAgICAgICBwYXltZW50VG9vbEFsbG93bGlzdD86IHN0cmluZ1tdO1xuICAgICAgICAgICAgbmV0d29ya1ByZWZlcmVuY2VzPzogc3RyaW5nW107XG4gICAgICAgICAgICBjb25uZWN0b3JzOiB7XG4gICAgICAgICAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgICAgICAgICAgcHJvdmlkZXI/OiBzdHJpbmc7XG4gICAgICAgICAgICAgIHByb3Zpc2lvbk1vZGU/OiAnTUFOVUFMJyB8ICdRVUlDS19DUkVBVEUnO1xuICAgICAgICAgICAgICBjcmVkZW50aWFsTmFtZT86IHN0cmluZztcbiAgICAgICAgICAgIH1bXTtcbiAgICAgICAgICB9KSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogcC5uYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHAuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBhdXRob3JpemVyVHlwZTogcC5hdXRob3JpemVyVHlwZSxcbiAgICAgICAgICAgIGF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiBwLmF1dGhvcml6ZXJDb25maWd1cmF0aW9uLFxuICAgICAgICAgICAgYXV0b1BheW1lbnQ6IHAuYXV0b1BheW1lbnQsXG4gICAgICAgICAgICBwYXltZW50VG9vbEFsbG93bGlzdDogcC5wYXltZW50VG9vbEFsbG93bGlzdCxcbiAgICAgICAgICAgIG5ldHdvcmtQcmVmZXJlbmNlczogcC5uZXR3b3JrUHJlZmVyZW5jZXMsXG4gICAgICAgICAgICBjb25uZWN0b3JzOiBwLmNvbm5lY3RvcnMubWFwKGMgPT4ge1xuICAgICAgICAgICAgICBpZiAoYy5wcm92aXNpb25Nb2RlID09PSAnUVVJQ0tfQ1JFQVRFJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAgICAgICAgICAgICBwcm92aWRlcjogJ0NvaW5iYXNlQ0RQJyBhcyBjb25zdCxcbiAgICAgICAgICAgICAgICAgIHByb3Zpc2lvbk1vZGU6ICdRVUlDS19DUkVBVEUnIGFzIGNvbnN0LFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBpZiAoIWMuY3JlZGVudGlhbE5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICBgTWFudWFsIHBheW1lbnQgY29ubmVjdG9yIFwiJHtjLm5hbWV9XCIgb24gbWFuYWdlciBcIiR7cC5uYW1lfVwiIGlzIG1pc3NpbmcgaXRzIGNyZWRlbnRpYWwgbmFtZS5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBjcmVkZW50aWFsUHJvdmlkZXJBcm4gPSBwYXltZW50Q3JlZGVudGlhbHM/LltjLmNyZWRlbnRpYWxOYW1lXT8uY3JlZGVudGlhbFByb3ZpZGVyQXJuO1xuICAgICAgICAgICAgICBpZiAoIWNyZWRlbnRpYWxQcm92aWRlckFybikge1xuICAgICAgICAgICAgICAgIC8vIEZhaWwgZmFzdCB3aXRoIGFuIGFjdGlvbmFibGUgbWVzc2FnZSByYXRoZXIgdGhhbiBwYXNzaW5nIGFuIGVtcHR5XG4gICAgICAgICAgICAgICAgLy8gQVJOIHRoYXQgZmFpbHMgb3BhcXVlbHkgc2VydmVyLXNpZGUgYXQgQ3JlYXRlUGF5bWVudENvbm5lY3Rvci5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICBgUGF5bWVudCBjb25uZWN0b3IgXCIke2MubmFtZX1cIiBvbiBtYW5hZ2VyIFwiJHtwLm5hbWV9XCIgcmVmZXJlbmNlcyBjcmVkZW50aWFsIGAgK1xuICAgICAgICAgICAgICAgICAgICBgXCIke2MuY3JlZGVudGlhbE5hbWV9XCIsIGJ1dCBubyBkZXBsb3llZCBjcmVkZW50aWFsIHByb3ZpZGVyIHdhcyBmb3VuZCBmb3IgaXQuIGAgK1xuICAgICAgICAgICAgICAgICAgICBgUnVuIFxcYGFnZW50Y29yZSBkZXBsb3lcXGAgc28gdGhlIGNyZWRlbnRpYWwgcHJvdmlkZXIgaXMgY3JlYXRlZCBmaXJzdC5gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgICAgICAgICAgICBwcm92aWRlcjogYy5wcm92aWRlcixcbiAgICAgICAgICAgICAgICAuLi4oYy5wcm92aXNpb25Nb2RlICYmIHsgcHJvdmlzaW9uTW9kZTogYy5wcm92aXNpb25Nb2RlIH0pLFxuICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxOYW1lOiBjLmNyZWRlbnRpYWxOYW1lLFxuICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxQcm92aWRlckFybixcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIH0pXG4gICAgICAgIClcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgbmV3IEFnZW50Q29yZVN0YWNrKGFwcCwgc3RhY2tOYW1lLCB7XG4gICAgICBzcGVjLFxuICAgICAgbWNwU3BlYyxcbiAgICAgIGNyZWRlbnRpYWxzLFxuICAgICAgY29ubmVjdG9yUGFyYW1ldGVyc0J5RmlsZSxcbiAgICAgIGhhcm5lc3NlczogaGFybmVzc0NvbmZpZ3MubGVuZ3RoID4gMCA/IGhhcm5lc3NDb25maWdzIDogdW5kZWZpbmVkLFxuICAgICAgcGF5bWVudFNwZWMsXG4gICAgICBlbnYsXG4gICAgICBkZXNjcmlwdGlvbjogYEFnZW50Q29yZSBzdGFjayBmb3IgJHtzcGVjLm5hbWV9IGRlcGxveWVkIHRvICR7dGFyZ2V0Lm5hbWV9ICgke3RhcmdldC5yZWdpb259KWAsXG4gICAgICB0YWdzOiB7XG4gICAgICAgICdhZ2VudGNvcmU6cHJvamVjdC1uYW1lJzogc3BlYy5uYW1lLFxuICAgICAgICAnYWdlbnRjb3JlOnRhcmdldC1uYW1lJzogdGFyZ2V0Lm5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgYXBwLnN5bnRoKCk7XG59XG5cbm1haW4oKS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgY29uc29sZS5lcnJvcignQWdlbnRDb3JlIENESyBzeW50aGVzaXMgZmFpbGVkOicsIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogZXJyb3IpO1xuICBwcm9jZXNzLmV4aXQoMSk7XG59KTtcbiJdfQ==