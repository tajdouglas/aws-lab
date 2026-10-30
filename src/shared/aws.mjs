import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";

let documents;
let queues;

export function documentClient() {
  documents ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return documents;
}

export function sqsClient() {
  queues ??= new SQSClient({});
  return queues;
}

export function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} não definido`);
  }
  return value;
}
