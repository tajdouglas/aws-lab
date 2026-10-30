import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { IAMClient, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  AddPermissionCommand,
  ListEventSourceMappingsCommand,
  CreateEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import {
  APIGatewayClient,
  GetRestApisCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  CreateResourceCommand,
  GetMethodCommand,
  PutMethodCommand,
  PutIntegrationCommand,
  CreateDeploymentCommand,
} from "@aws-sdk/client-api-gateway";
import {
  accountId,
  apiName,
  assertNode,
  clientConfig,
  endpoint,
  functions,
  lambdaEndpoint,
  queueName,
  region,
  roleName,
  root,
  stageName,
  tableName,
} from "./config.mjs";
import { waitForLocalStack } from "./health.mjs";

assertNode();

const config = clientConfig();
const dynamo = new DynamoDBClient(config);
const sqs = new SQSClient(config);
const iam = new IAMClient(config);
const lambda = new LambdaClient(config);
const api = new APIGatewayClient(config);

await waitForLocalStack();
console.log("LocalStack pronto");

await ensureTable();
const queueUrl = await ensureQueue();
const queueArn = await queueArnOf(queueUrl);
const roleArn = await ensureRole(queueArn);
console.log(`role ${roleName}`);

const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
const lambdaQueueUrl = rewriteHost(queueUrl, lambdaEndpoint);
const environment = {
  TABLE_NAME: tableName,
  QUEUE_URL: lambdaQueueUrl,
  AWS_ENDPOINT_URL: lambdaEndpoint,
  AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED: "true",
};

for (const name of functions) {
  await upsertFunction(name, environment, roleArn, architecture);
  console.log(`função ${name}`);
}

await ensureEventSourceMapping(queueArn);
console.log("event source mapping process-order");

const restApiId = await ensureRestApi();
const baseUrl = `${endpoint}/restapis/${restApiId}/${stageName}/_user_request_`;
await ensureRoutes(restApiId);
await writeFile(join(root, "dist", "api.json"), JSON.stringify({ restApiId, baseUrl }, null, 2));
await mkdir(join(root, "web"), { recursive: true });
await writeFile(join(root, "web", "config.js"), `window.ORDERS_API = ${JSON.stringify(baseUrl)};\n`);
console.log(`API ${baseUrl}`);

async function ensureTable() {
  try {
    await dynamo.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
  } catch (error) {
    if (!hasName(error, "ResourceInUseException")) {
      throw error;
    }
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const described = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    if (described.Table?.TableStatus === "ACTIVE") {
      console.log(`tabela ${tableName}`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`tabela ${tableName} não ficou ativa`);
}

async function ensureQueue() {
  try {
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: existing.QueueUrl,
        Attributes: { VisibilityTimeout: "30" },
      }),
    );
    console.log(`fila ${queueName}`);
    return existing.QueueUrl;
  } catch (error) {
    if (!hasName(error, "QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue")) {
      throw error;
    }
  }

  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { VisibilityTimeout: "30" },
    }),
  );
  console.log(`fila ${queueName}`);
  return created.QueueUrl;
}

async function queueArnOf(queueUrl) {
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  const queueArn = attributes.Attributes?.QueueArn;
  if (!queueArn) {
    throw new Error("fila sem ARN");
  }
  return queueArn;
}

async function ensureRole(queueArn) {
  const assumeRolePolicyDocument = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  try {
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
      }),
    );
  } catch (error) {
    if (!hasName(error, "EntityAlreadyExistsException")) {
      throw error;
    }
  }

  const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  if (!role.Role?.Arn) {
    throw new Error(`role ${roleName} sem ARN`);
  }
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "orders-lambda-policy",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `arn:aws:logs:${region}:${accountId}:*`,
          },
          {
            Effect: "Allow",
            Action: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
            Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`,
          },
          {
            Effect: "Allow",
            Action: [
              "sqs:SendMessage",
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: queueArn,
          },
        ],
      }),
    }),
  );
  return role.Role.Arn;
}

async function upsertFunction(name, environment, roleArn, architecture) {
  const zipPath = join(root, "dist", `${name}.zip`);
  try {
    await stat(zipPath);
  } catch {
    throw new Error(`zip não encontrado: ${zipPath}. Rode npm run build.`);
  }
  const zipFile = await readFile(zipPath);

  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    await sendWhenReady(new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: zipFile }));
    await waitForFunction(name);
    await sendWhenReady(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Role: roleArn,
        Handler: "index.handler",
        Timeout: 30,
        MemorySize: 256,
        Environment: { Variables: environment },
      }),
    );
    await waitForFunction(name);
    return;
  } catch (error) {
    if (!hasName(error, "ResourceNotFoundException")) {
      throw error;
    }
  }

  await lambda.send(
    new CreateFunctionCommand({
      FunctionName: name,
      Runtime: "nodejs20.x",
      Handler: "index.handler",
      Role: roleArn,
      Code: { ZipFile: zipFile },
      Timeout: 30,
      MemorySize: 256,
      Architectures: [architecture],
      Environment: { Variables: environment },
      Description: descriptionOf(name),
    }),
  );
  await waitForFunction(name);
}

function descriptionOf(name) {
  if (name === "create-order") return "Grava o pedido e publica na fila";
  if (name === "process-order") return "Confirma ou recusa o pedido";
  return "Consulta o pedido";
}

async function waitForFunction(name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    const state = result.Configuration?.State;
    const update = result.Configuration?.LastUpdateStatus;
    if ((state === "Active" || state == null) && (update === "Successful" || update == null)) {
      return result;
    }
    if (state === "Failed" || update === "Failed") {
      const reason = result.Configuration?.StateReason ?? result.Configuration?.LastUpdateStatusReason;
      throw new Error(`função ${name} falhou: ${reason}`);
    }
    await sleep(500);
  }
  throw new Error(`função ${name} não ficou ativa`);
}

async function ensureEventSourceMapping(queueArn) {
  const listed = await lambda.send(
    new ListEventSourceMappingsCommand({
      FunctionName: "process-order",
      EventSourceArn: queueArn,
    }),
  );
  const existing = listed.EventSourceMappings?.[0];
  if (existing?.UUID) {
    await lambda.send(
      new UpdateEventSourceMappingCommand({
        UUID: existing.UUID,
        BatchSize: 1,
        Enabled: true,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      }),
    );
    return;
  }

  await lambda.send(
    new CreateEventSourceMappingCommand({
      FunctionName: "process-order",
      EventSourceArn: queueArn,
      BatchSize: 1,
      Enabled: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    }),
  );
}

async function ensureRestApi() {
  const listed = await api.send(new GetRestApisCommand({ limit: 500 }));
  const found = listed.items?.find((item) => item.name === apiName);
  if (found?.id) {
    return found.id;
  }
  const created = await api.send(
    new CreateRestApiCommand({
      name: apiName,
      endpointConfiguration: { types: ["REGIONAL"] },
    }),
  );
  return created.id;
}

async function ensureRoutes(restApiId) {
  const resources = await api.send(new GetResourcesCommand({ restApiId, limit: 500 }));
  const rootResource = resources.items?.find((item) => item.path === "/");
  if (!rootResource?.id) {
    throw new Error("API sem recurso raiz");
  }

  const orders = await ensureResource(restApiId, rootResource.id, "orders");
  const byId = await ensureResource(restApiId, orders.id, "{orderId}");
  const createArn = await functionArn("create-order");
  const getArn = await functionArn("get-order");

  await ensureMethod(restApiId, orders.id, "POST");
  await ensureMethod(restApiId, orders.id, "OPTIONS");
  await ensureMethod(restApiId, byId.id, "GET", {
    "method.request.path.orderId": true,
  });
  await ensureMethod(restApiId, byId.id, "OPTIONS");
  await putProxy(restApiId, orders.id, "POST", createArn);
  await putProxy(restApiId, orders.id, "OPTIONS", createArn);
  await putProxy(restApiId, byId.id, "GET", getArn);
  await putProxy(restApiId, byId.id, "OPTIONS", getArn);
  await allowInvoke("create-order", restApiId, "POST", "orders");
  await allowInvoke("create-order", restApiId, "OPTIONS", "orders");
  await allowInvoke("get-order", restApiId, "GET", "orders/*");
  await allowInvoke("get-order", restApiId, "OPTIONS", "orders/*");
  await api.send(new CreateDeploymentCommand({ restApiId, stageName }));
}

async function ensureResource(restApiId, parentId, pathPart) {
  const listed = await api.send(new GetResourcesCommand({ restApiId, limit: 500 }));
  const found = listed.items?.find((item) => item.parentId === parentId && item.pathPart === pathPart);
  if (found) {
    return found;
  }
  return api.send(new CreateResourceCommand({ restApiId, parentId, pathPart }));
}

async function ensureMethod(restApiId, resourceId, httpMethod, requestParameters) {
  try {
    await api.send(new GetMethodCommand({ restApiId, resourceId, httpMethod }));
    return;
  } catch (error) {
    if (!hasName(error, "NotFoundException")) {
      throw error;
    }
  }
  await api.send(
    new PutMethodCommand({
      restApiId,
      resourceId,
      httpMethod,
      authorizationType: "NONE",
      requestParameters,
    }),
  );
}

async function putProxy(restApiId, resourceId, httpMethod, functionArn) {
  await api.send(
    new PutIntegrationCommand({
      restApiId,
      resourceId,
      httpMethod,
      type: "AWS_PROXY",
      integrationHttpMethod: "POST",
      uri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`,
    }),
  );
}

async function allowInvoke(functionName, restApiId, httpMethod, resourcePath) {
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: functionName,
        StatementId: `apigateway-${functionName}-${httpMethod}`,
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: `arn:aws:execute-api:${region}:${accountId}:${restApiId}/*/${httpMethod}/${resourcePath}`,
      }),
    );
  } catch (error) {
    if (!hasName(error, "ResourceConflictException")) {
      throw error;
    }
  }
}

async function functionArn(name) {
  const result = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
  const arn = result.Configuration?.FunctionArn;
  if (!arn) {
    throw new Error(`função ${name} sem ARN`);
  }
  return arn;
}

function rewriteHost(queueUrl, lambdaBase) {
  const target = new URL(lambdaBase);
  const url = new URL(queueUrl);
  url.protocol = target.protocol;
  url.host = target.host;
  return url.toString();
}

async function sendWhenReady(command) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      return await lambda.send(command);
    } catch (error) {
      if (!hasName(error, "ResourceConflictException") || attempt === 20) {
        throw error;
      }
      await sleep(500);
    }
  }
  throw new Error("atualização da função não concluiu");
}

function hasName(error, ...names) {
  return names.includes(error?.name) || names.includes(error?.Code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
