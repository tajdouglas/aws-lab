import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetQueueAttributesCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { LambdaClient, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { assertNode, clientConfig, functions, queueName, root, tableName } from "./config.mjs";
import { formatEvent } from "./format-log.mjs";

assertNode();

const config = clientConfig();
const documents = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const sqs = new SQSClient(config);
const lambda = new LambdaClient(config);
const logs = new CloudWatchLogsClient(config);

const api = await readApi();
console.log(api ? `API  ${api.baseUrl}` : "API  dist/api.json ausente. Rode npm run provision.");

const queueUrl = await queueUrlOf();
const attributes = await sqs.send(
  new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
  }),
);
const visible = attributes.Attributes?.ApproximateNumberOfMessages ?? "?";
const inFlight = attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "?";
console.log(`Fila ${queueName}  visíveis=${visible}  em processamento=${inFlight}  ${queueUrl}`);

const mappings = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "process-order" }));
for (const mapping of mappings.EventSourceMappings ?? []) {
  console.log(`Consumidor process-order  ${mapping.State}  uuid=${mapping.UUID}  lote=${mapping.BatchSize}`);
}

const received = await sqs.send(
  new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
    VisibilityTimeout: 0,
  }),
);
const messages = received.Messages ?? [];
if (messages.length === 0) {
  console.log("Mensagens na fila: nenhuma agora");
} else {
  console.log("Mensagens na fila (devolvidas na hora, o consumidor ainda pode pegá-las):");
  for (const message of messages) {
    console.log(`  ${message.Body}`);
  }
}

const scanned = await documents.send(new ScanCommand({ TableName: tableName }));
const orders = (scanned.Items ?? []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
console.log(`Tabela ${tableName}  ${orders.length} pedido(s)`);
for (const order of orders) {
  console.log(
    `  ${order.status.padEnd(9)} ${String(order.totalCents).padStart(6)} centavos  ${order.orderId}  ${order.customerName}  ${order.reason ?? ""}`,
  );
}

console.log("Logs recentes:");
const since = Date.now() - 15 * 60 * 1000;
const recent = [];
for (const name of functions) {
  const group = `/aws/lambda/${name}`;
  try {
    const page = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: group,
        startTime: since,
        limit: 50,
      }),
    );
    for (const event of page.events ?? []) {
      if ((event.message ?? "").includes("NodeVersionSupportWarning")) {
        continue;
      }
      recent.push({ group, event });
    }
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") {
      throw error;
    }
  }
}
recent.sort((a, b) => a.event.timestamp - b.event.timestamp);
const shown = recent.slice(-12);
for (const item of shown) {
  console.log(formatEvent(item.group, item.event));
}
if (shown.length === 0) {
  console.log("  nenhum. Chame um pedido com a API no ar e rode npm run logs para acompanhar.");
}

async function queueUrlOf() {
  const found = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  return found.QueueUrl;
}

async function readApi() {
  try {
    return JSON.parse(await readFile(join(root, "dist", "api.json"), "utf8"));
  } catch {
    return null;
  }
}
