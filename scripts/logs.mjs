import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { assertNode, clientConfig, functions } from "./config.mjs";
import { formatEvent } from "./format-log.mjs";

assertNode();

const logs = new CloudWatchLogsClient(clientConfig());
const groups = functions.map((name) => `/aws/lambda/${name}`);
const seen = new Set();
let startTime = Date.now();

console.log("CloudWatch Logs ao vivo. Ctrl+C para parar.");
console.log("START/END/REPORT vêm do runtime. As linhas JSON com step vêm do código.");
for (const group of groups) {
  console.log(`  ${group}`);
}

while (true) {
  for (const group of groups) {
    for (const event of await readEvents(group, startTime)) {
      const id = event.eventId ?? `${event.timestamp}:${event.message}`;
      if (seen.has(id) || isNoise(event.message)) {
        continue;
      }
      seen.add(id);
      if (event.timestamp > startTime) {
        startTime = event.timestamp;
      }
      console.log(formatEvent(group, event));
    }
  }
  await sleep(1000);
}

async function readEvents(group, from) {
  try {
    const page = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: group,
        startTime: from,
        limit: 100,
      }),
    );
    return page.events ?? [];
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      return [];
    }
    throw error;
  }
}

function isNoise(message) {
  return (message ?? "").includes("NodeVersionSupportWarning");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
