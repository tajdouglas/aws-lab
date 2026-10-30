let context;

export function bindContext(value) {
  context = value;
}

export function log(step, fields = {}) {
  const requestId = context?.awsRequestId;
  console.log(
    JSON.stringify({
      function: process.env.AWS_LAMBDA_FUNCTION_NAME ?? "local",
      ...(requestId ? { requestId } : {}),
      step,
      ...fields,
    }),
  );
}
