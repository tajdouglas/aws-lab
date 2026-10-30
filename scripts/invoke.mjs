import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { assertNode, clientConfig } from "./config.mjs";

assertNode();

const command = process.argv[2];
const lambda = new LambdaClient(clientConfig());

if (command === "create") {
  const order = process.argv[3]
    ? JSON.parse(process.argv[3])
    : { customerName: "Ana", items: [{ sku: "CADERNO", qty: 2, unitCents: 1500 }] };
  await invoke("create-order", {
    httpMethod: "POST",
    path: "/orders",
    body: JSON.stringify(order),
    isBase64Encoded: false,
  });
} else if (command === "get") {
  const orderId = requiredArg("orderId");
  await invoke("get-order", {
    httpMethod: "GET",
    path: `/orders/${orderId}`,
    pathParameters: { orderId },
  });
} else if (command === "process") {
  const orderId = requiredArg("orderId");
  await invoke("process-order", {
    Records: [
      {
        messageId: "manual",
        body: JSON.stringify({ orderId }),
      },
    ],
  });
} else {
  console.error(`uso:
  npm run invoke -- create
  npm run invoke -- create '{"customerName":"Ana","items":[{"sku":"CADERNO","qty":1,"unitCents":3000}]}'
  npm run invoke -- get <orderId>
  npm run invoke -- process <orderId>`);
  process.exit(1);
}

function requiredArg(name) {
  const value = process.argv[3];
  if (!value) {
    throw new Error(`${name} é obrigatório`);
  }
  return value;
}

async function invoke(functionName, event) {
  console.log(`lambda invoke ${functionName}`);
  console.log(JSON.stringify(event, null, 2));
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(event)),
      LogType: "Tail",
    }),
  );
  const payload = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "";
  console.log(`status ${result.StatusCode}${result.FunctionError ? ` erro ${result.FunctionError}` : ""}`);
  console.log(payload);
  if (result.LogResult) {
    console.log("--- log desta chamada ---");
    console.log(Buffer.from(result.LogResult, "base64").toString("utf8").trimEnd());
  }
}
