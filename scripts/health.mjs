const HEALTH_URL = "http://127.0.0.1:4566/_localstack/health";
const REQUIRED = ["lambda", "dynamodb", "sqs", "apigateway", "iam"];

export async function waitForLocalStack({ timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "sem resposta";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) {
        const body = await response.json();
        const services = body.services ?? {};
        const pending = REQUIRED.filter(
          (name) => !["available", "running"].includes(services[name]),
        );
        if (pending.length === 0) {
          return body;
        }
        last = `aguardando ${pending.join(", ")}`;
      } else {
        last = `health HTTP ${response.status}`;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`LocalStack não ficou pronto. ${last}`);
}
