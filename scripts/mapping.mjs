import { LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from "@aws-sdk/client-lambda";
import { assertNode, clientConfig } from "./config.mjs";

assertNode();

const action = process.argv[2];
if (action !== "pause" && action !== "resume") {
  console.error("uso: node scripts/mapping.mjs pause|resume");
  process.exit(1);
}

const lambda = new LambdaClient(clientConfig());
const listed = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "process-order" }));
const mapping = listed.EventSourceMappings?.[0];
if (!mapping?.UUID) {
  throw new Error("event source mapping de process-order não encontrado. Rode npm run provision.");
}

const enabled = action === "resume";
await lambda.send(new UpdateEventSourceMappingCommand({ UUID: mapping.UUID, Enabled: enabled }));

const wanted = enabled ? "Enabled" : "Disabled";
const deadline = Date.now() + 20_000;
let state = mapping.State;
while (Date.now() < deadline) {
  const again = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: "process-order" }));
  state = again.EventSourceMappings?.find((item) => item.UUID === mapping.UUID)?.State;
  if (state === wanted) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

console.log(`consumidor process-order ${state}  uuid=${mapping.UUID}`);
if (!enabled) {
  console.log("A fila para de chamar a Lambda. Um POST agora deixa o pedido RECEIVED e a mensagem visível.");
  console.log("npm run resume liga o consumidor de novo. npm run provision também liga.");
}
