import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const region = "us-east-1";
export const accountId = "000000000000";
export const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566";
export const lambdaEndpoint = "http://localhost.localstack.cloud:4566";
export const credentials = { accessKeyId: "test", secretAccessKey: "test" };
export const tableName = "orders";
export const queueName = "orders";
export const roleName = "orders-lambda-role";
export const apiName = "orders-api";
export const stageName = "dev";
export const functions = ["create-order", "process-order", "get-order"];

export function clientConfig() {
  return { region, endpoint, credentials };
}

export function assertNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    throw new Error("Node.js 20 ou mais recente é necessário");
  }
}
