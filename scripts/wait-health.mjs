import { assertNode } from "./config.mjs";
import { waitForLocalStack } from "./health.mjs";

assertNode();
await waitForLocalStack();
console.log("LocalStack pronto em http://127.0.0.1:4566");
