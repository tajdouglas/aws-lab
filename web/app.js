const steps = [
  ["browser", "Navegador", "Envia POST /orders"],
  ["apigw", "API Gateway", "Entrega o HTTP para a Lambda"],
  ["create", "Lambda create-order", "Valida o pedido"],
  ["dynamo", "DynamoDB", "Grava status RECEIVED"],
  ["sqs", "SQS", "Guarda a mensagem { orderId }"],
  ["process", "Lambda process-order", "A fila chama esta função"],
  ["final", "Estado final", "CONFIRMED ou REJECTED"],
];

const ENDPOINT = "http://127.0.0.1:4566";
const form = document.querySelector("#order-form");
const apiBase = document.querySelector("#api-base");
const formError = document.querySelector("#form-error");
const path = document.querySelector("#path");
const pill = document.querySelector("#status-pill");
const lessonTitle = document.querySelector("#lesson-title");
const lessonText = document.querySelector("#lesson-text");
const lessonBlocks = document.querySelector("#lesson-blocks");

let phase = "idle";
let created = null;
let order = null;
let sentBody = null;
let selected = "browser";

apiBase.value = window.ORDERS_API || "";
buildPath();
render();

document.querySelector("#fill-ok").addEventListener("click", () => fill("Ana", "CADERNO", 2, "15.00"));
document.querySelector("#fill-over").addEventListener("click", () => fill("Bruno", "MESA", 1, "600.00"));
form.addEventListener("input", () => {
  if (!sentBody) render();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendOrder();
});

function fill(customer, sku, qty, price) {
  form.customerName.value = customer;
  form.sku.value = sku;
  form.qty.value = qty;
  form.price.value = price;
  if (!sentBody) render();
  form.customerName.focus();
}

async function sendOrder() {
  hideError();
  const base = baseUrl();
  const unitCents = reaisToCents(form.price.value);
  const qty = Number(form.qty.value);
  if (!base || unitCents == null || !Number.isInteger(qty)) {
    showError("Preencha a API, uma quantidade inteira e um preço válido.");
    return;
  }

  const request = {
    customerName: form.customerName.value.trim(),
    items: [{ sku: form.sku.value.trim(), qty, unitCents }],
  };
  form.querySelector("button[type=submit]").disabled = true;
  phase = "sending";
  order = null;
  created = null;
  sentBody = request;
  selected = "browser";
  render();

  try {
    const response = await call("POST", `${base}/orders`, request);
    if (response.status >= 400 || !response.body?.orderId) {
      showError(response.body?.message || "A API recusou o pedido.");
      phase = "error";
      render();
      return;
    }
    created = response.body;
    order = created;
    phase = "received";
    render();
    order = await poll(base, order.orderId, order.status);
    phase = "done";
    render();
  } catch (error) {
    showError(error.message);
    phase = "error";
    render();
  } finally {
    form.querySelector("button[type=submit]").disabled = false;
  }
}

async function poll(base, orderId, initialStatus) {
  const deadline = Date.now() + 20_000;
  let last = order;
  let seen = initialStatus;
  while (Date.now() < deadline) {
    await wait(700);
    const result = await call("GET", `${base}/orders/${orderId}`);
    last = result.body;
    order = last;
    if (last.status === "CONFIRMED" || last.status === "REJECTED") return last;
    if (last.status !== seen) seen = last.status;
    phase = "received";
    render();
  }
  throw new Error("O pedido continuou RECEIVED. O consumidor da fila pode estar desligado.");
}

async function call(method, url, payload) {
  const response = await fetch(url, {
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (body && typeof body.statusCode === "number" && "body" in body) {
    const inner = typeof body.body === "string" ? JSON.parse(body.body) : body.body;
    return { status: body.statusCode, body: inner };
  }
  return { status: response.status, body };
}

function buildPath() {
  path.replaceChildren(
    ...steps.map(([id, title, text]) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.step = id;
      const heading = document.createElement("strong");
      heading.textContent = title;
      const copy = document.createElement("p");
      copy.dataset.copy = id;
      copy.textContent = text;
      button.append(heading, copy);
      button.addEventListener("click", () => {
        selected = id;
        render();
      });
      item.append(button);
      return item;
    }),
  );
}

function render() {
  for (const item of path.children) {
    const button = item.querySelector("button");
    const id = button.dataset.step;
    item.className = `${stepState(id)}${id === selected ? " selected" : ""}`.trim();
    button.setAttribute("aria-pressed", id === selected ? "true" : "false");
    item.querySelector("p").textContent = stepDetail(id);
  }
  paintPill();
  paintLesson();
}

function paintPill() {
  pill.className = "pill";
  if (phase === "idle") pill.textContent = "aguardando";
  else if (phase === "sending") {
    pill.textContent = "enviando";
    pill.classList.add("wait");
  } else if (phase === "error") {
    pill.textContent = "erro";
    pill.classList.add("bad");
  } else if (order?.status === "CONFIRMED") {
    pill.textContent = "CONFIRMED";
    pill.classList.add("ok");
  } else if (order?.status === "REJECTED") {
    pill.textContent = "REJECTED";
    pill.classList.add("bad");
  } else {
    pill.textContent = order?.status ?? "RECEIVED";
    pill.classList.add("wait");
  }
}

function paintLesson() {
  const lesson = lessons()[selected];
  lessonTitle.textContent = lesson.title;
  lessonText.textContent = lesson.text;
  lessonBlocks.replaceChildren(
    ...lesson.blocks.map((block) => {
      const wrap = document.createElement("div");
      wrap.className = "block";
      const label = document.createElement("span");
      label.textContent = block.label;
      const code = document.createElement("pre");
      code.textContent = block.code;
      wrap.append(label, code);
      return wrap;
    }),
  );
}

function lessons() {
  const base = baseUrl() || `${ENDPOINT}/restapis/API_ID/dev/_user_request_`;
  const id = (base.match(/\/restapis\/([^/]+)\//) ?? [])[1] || "API_ID";
  const body = sentBody || previewBody();
  const orderId = order?.orderId || "ORDER_ID";
  const message = JSON.stringify({ orderId });
  const proxyEvent = {
    httpMethod: "POST",
    path: "/orders",
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
  const sqsEvent = { Records: [{ messageId: "gerado-pela-fila", body: message }] };

  return {
    browser: {
      title: "Navegador",
      text: "A página faz um POST. A resposta nasce com status RECEIVED: a confirmação ainda não aconteceu.",
      blocks: [
        { label: "Comando", code: curlPost(base, body) },
        {
          label: created ? "Resposta deste POST" : "Corpo que será enviado",
          code: JSON.stringify(created || body, null, 2),
        },
      ],
    },
    apigw: {
      title: "API Gateway",
      text: "A rota não contém a regra do pedido. POST /orders está integrado à Lambda create-order no modo AWS_PROXY: o HTTP vira o evento abaixo, e o statusCode que a função devolve vira o HTTP da resposta.",
      blocks: [
        {
          label: "Ligação da rota na função",
          code: `aws apigateway get-resources \\
  --endpoint-url ${ENDPOINT} \\
  --rest-api-id ${id}

aws apigateway put-integration \\
  --endpoint-url ${ENDPOINT} \\
  --rest-api-id ${id} \\
  --resource-id ID_DO_RECURSO_/orders \\
  --http-method POST \\
  --type AWS_PROXY \\
  --integration-http-method POST \\
  --uri arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:000000000000:function:create-order/invocations`,
        },
        { label: "Evento entregue à Lambda", code: JSON.stringify(proxyEvent, null, 2) },
      ],
    },
    create: {
      title: "Lambda create-order",
      text: "A função valida o body, grava o item e publica só o orderId na fila. O mesmo efeito, sem passar pelo HTTP, é um lambda invoke com o evento da etapa anterior.",
      blocks: [
        {
          label: "Comando",
          code: `aws lambda invoke \\
  --endpoint-url ${ENDPOINT} \\
  --function-name create-order \\
  --cli-binary-format raw-in-base64-out \\
  --payload '${JSON.stringify(proxyEvent)}' \\
  /tmp/create-order.json`,
        },
        {
          label: "O que ela gravou na trilha",
          code: JSON.stringify(order?.trail?.filter((hop) => hop.step !== "process-order") || [
            { step: "create-order", detail: "PutItem com status RECEIVED" },
            { step: "sqs", detail: "SendMessage com o orderId" },
          ], null, 2),
        },
      ],
    },
    dynamo: {
      title: "DynamoDB",
      text: "A tabela orders tem uma chave, orderId. O status começa RECEIVED. A etapa final é um UpdateItem no mesmo item, não um item novo.",
      blocks: [
        {
          label: "Comando",
          code: `aws dynamodb get-item \\
  --endpoint-url ${ENDPOINT} \\
  --table-name orders \\
  --key '{"orderId":{"S":"${orderId}"}}'`,
        },
        {
          label: order ? "Item deste pedido" : "Ainda sem item",
          code: order ? JSON.stringify(order, null, 2) : "Envie um pedido para ver o item gravado.",
        },
      ],
    },
    sqs: {
      title: "SQS",
      text: "A mensagem não leva o pedido inteiro. Leva a chave, para a outra função buscar o item. Enquanto o status está RECEIVED, essa mensagem está na fila ou acabou de ser consumida.",
      blocks: [
        {
          label: "Corpo publicado pela create-order",
          code: message,
        },
        {
          label: "Ver a mensagem sem apagá-la",
          code: `QUEUE_URL=$(aws sqs get-queue-url \\
  --endpoint-url ${ENDPOINT} \\
  --queue-name orders \\
  --query QueueUrl --output text)

aws sqs receive-message \\
  --endpoint-url ${ENDPOINT} \\
  --queue-url "$QUEUE_URL" \\
  --max-number-of-messages 1 \\
  --visibility-timeout 0`,
        },
      ],
    },
    process: {
      title: "Lambda process-order",
      text: "O código da função não escolhe a fila. Ele só lê event.Records. Quem liga a fila orders na função process-order é um event source mapping, um recurso separado. Sem esse comando, a mensagem fica na fila e a função nunca é chamada.",
      blocks: [
        {
          label: "Comando que faz a função escutar a fila",
          code: `aws lambda create-event-source-mapping \\
  --endpoint-url ${ENDPOINT} \\
  --function-name process-order \\
  --event-source-arn arn:aws:sqs:us-east-1:000000000000:orders \\
  --batch-size 1 \\
  --enabled`,
        },
        {
          label: "A role precisa poder consumir a fila",
          code: `sqs:ReceiveMessage
sqs:DeleteMessage
sqs:GetQueueAttributes
no ARN arn:aws:sqs:us-east-1:000000000000:orders`,
        },
        {
          label: "Conferir a ligação",
          code: `aws lambda list-event-source-mappings \\
  --endpoint-url ${ENDPOINT} \\
  --function-name process-order`,
        },
        { label: "Evento que a fila entrega", code: JSON.stringify(sqsEvent, null, 2) },
      ],
    },
    final: {
      title: "Estado final",
      text: order?.status === "REJECTED"
        ? "A função da fila atualizou o mesmo item para REJECTED. O motivo está em reason."
        : "A função da fila atualizou o mesmo item. CONFIRMED é o caminho normal; REJECTED é total acima de R$ 500,00 ou quantidade 0.",
      blocks: [
        { label: "Consulta", code: `curl -s '${base}/orders/${orderId}'` },
        {
          label: "Resultado",
          code: order
            ? JSON.stringify({ status: order.status, reason: order.reason ?? null, totalCents: order.totalCents }, null, 2)
            : "Envie um pedido para ver CONFIRMED ou REJECTED.",
        },
      ],
    },
  };
}

function curlPost(base, body) {
  return `curl -s -X POST '${base}/orders' \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify(body)}'`;
}

function previewBody() {
  const unitCents = reaisToCents(form.price.value);
  const qty = Number(form.qty.value);
  return {
    customerName: form.customerName.value.trim() || "Ana",
    items: [{
      sku: form.sku.value.trim() || "CADERNO",
      qty: Number.isInteger(qty) ? qty : 1,
      unitCents: unitCents ?? 0,
    }],
  };
}

function stepState(id) {
  if (phase === "idle") return "";
  if (phase === "error") return id === "browser" || id === "apigw" ? "bad" : "";
  if (phase === "sending") return id === "browser" ? "current" : "";
  const terminal = order?.status === "CONFIRMED" || order?.status === "REJECTED";
  const written = ["browser", "apigw", "create", "dynamo", "sqs"];
  if (!terminal) {
    if (written.includes(id)) return "done";
    if (id === "process") return "current";
    return "";
  }
  if (id === "final" && order.status === "REJECTED") return "bad";
  return "done";
}

function stepDetail(id) {
  const trailId = { create: "create-order", sqs: "sqs", process: "process-order" }[id];
  const hop = (order?.trail ?? []).find((item) => item.step === trailId);
  if (id === "final" && order?.status) return `${order.status}${order.reason ? ` · ${order.reason}` : ""}`;
  if (id === "dynamo" && order?.totalCents != null) return `${order.totalCents} centavos · ${order.status}`;
  if (hop?.detail || hop?.reason) return hop.detail || hop.reason;
  return steps.find((step) => step[0] === id)[2];
}

function baseUrl() {
  return apiBase.value.trim().replace(/\/$/, "");
}

function reaisToCents(value) {
  const reais = Number(String(value).replace(",", "."));
  if (!Number.isFinite(reais) || reais < 0) return null;
  return Math.round(reais * 100);
}

function showError(message) {
  formError.hidden = false;
  formError.textContent = message;
}

function hideError() {
  formError.hidden = true;
  formError.textContent = "";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
