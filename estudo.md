# O pedido, fase por fase, com a AWS CLI

Os recursos já existem depois de `npm run up`, `npm run build` e `npm run provision`. O que segue não cria nada sozinho: cada bloco é um comando para você rodar e ler a resposta. A CLI fala com o LocalStack no lugar da AWS.

Confira a versão. Precisa ser a AWS CLI v2.

```bash
aws --version
```

Se o comando não existir:

```bash
brew install awscli
```

No terminal em que você vai trabalhar:

```bash
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export ENDPOINT=http://127.0.0.1:4566
```

`test` / `test` são as credenciais do lab. `--endpoint-url "$ENDPOINT"` desvia cada chamada de `amazonaws.com` para a porta 4566.

## Fase 1. Ver os recursos

A função, a tabela e a fila são três serviços. Estes comandos só listam.

```bash
aws lambda list-functions --endpoint-url "$ENDPOINT" \
  --query "Functions[].FunctionName" --output table

aws dynamodb describe-table --endpoint-url "$ENDPOINT" \
  --table-name orders --query "Table.{nome:TableName,status:TableStatus,chave:KeySchema}"

aws sqs get-queue-url --endpoint-url "$ENDPOINT" --queue-name orders

aws apigateway get-rest-apis --endpoint-url "$ENDPOINT" \
  --query "items[?name=='orders-api'].id" --output text
```

Guarde o id da API. A URL que o navegador e o `curl` usam é:

```bash
API_ID=$(aws apigateway get-rest-apis --endpoint-url "$ENDPOINT" \
  --query "items[?name=='orders-api'].id" --output text)
echo "http://127.0.0.1:4566/restapis/${API_ID}/dev/_user_request_"
```

O trecho `/_user_request_` é do LocalStack. Na AWS a URL do stage não tem isso.

## Como a Lambda passa a escutar a fila

O arquivo `src/process-order/index.mjs` não escolhe a fila. Ele só lê `event.Records` quando alguém já o invocou. Quem faz essa ligação é outro recurso, o event source mapping: a fila `orders` de um lado, a função `process-order` do outro.

```bash
aws lambda create-event-source-mapping \
  --endpoint-url "$ENDPOINT" \
  --function-name process-order \
  --event-source-arn arn:aws:sqs:us-east-1:000000000000:orders \
  --batch-size 1 \
  --enabled
```

`--batch-size 1` entrega uma mensagem por invocação. A role da função precisa de `sqs:ReceiveMessage`, `sqs:DeleteMessage` e `sqs:GetQueueAttributes`, senão o mapping existe e a invocação falha. Para ver se a ligação está de pé:

```bash
aws lambda list-event-source-mappings --endpoint-url "$ENDPOINT" \
  --function-name process-order
```

O mesmo tipo de ligação existe no HTTP, com outro comando. `POST /orders` chama `create-order` porque a rota do API Gateway tem uma integração `AWS_PROXY` para o ARN dessa função. A página do lab mostra esse comando ao clicar na etapa API Gateway, e o mapping ao clicar em Lambda process-order.

## Fase 2. Segurar a mensagem na fila

O consumidor está ligado, então a mensagem some em menos de um segundo. Desligue o event source mapping para conseguir ver a fase da fila.

```bash
aws lambda list-event-source-mappings --endpoint-url "$ENDPOINT" \
  --function-name process-order \
  --query "EventSourceMappings[].{uuid:UUID,estado:State}"
```

Copie o `uuid` e desligue:

```bash
aws lambda update-event-source-mapping --endpoint-url "$ENDPOINT" \
  --uuid COLE-O-UUID --no-enabled
```

`--no-enabled` pede `Enabled=false`. Rode o `list` de novo até `State` ser `Disabled`. A partir daqui um pedido novo fica `RECEIVED` e a mensagem permanece na fila. Nada chama `process-order`.

## Fase 3. Chamar a Lambda de criação

O arquivo abaixo é o evento que o API Gateway mandaria. O pedido de verdade está dentro de `body`, como texto, porque é assim que a integração proxy entrega o HTTP.

```bash
cat > /tmp/create-order.json <<'EOF'
{
  "httpMethod": "POST",
  "path": "/orders",
  "isBase64Encoded": false,
  "body": "{\"customerName\":\"Ana\",\"items\":[{\"sku\":\"CADERNO\",\"qty\":2,\"unitCents\":1500}]}"
}
EOF

aws lambda invoke --endpoint-url "$ENDPOINT" \
  --function-name create-order \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \
  --payload file:///tmp/create-order.json \
  /tmp/create-order-resposta.json

cat /tmp/create-order-resposta.json
```

`--cli-binary-format raw-in-base64-out` manda o JSON do arquivo como está. Sem isso a CLI v2 espera o payload em base64. A resposta é o objeto da Lambda (`statusCode` 201 e o pedido dentro de `body`), não o JSON puro do pedido. Copie o `orderId`.

O log desta execução vem na resposta do invoke, no campo `LogResult`, em base64. No macOS o decode é `-D`:

```bash
aws lambda invoke --endpoint-url "$ENDPOINT" \
  --function-name create-order \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \
  --payload file:///tmp/create-order.json \
  --query LogResult --output text \
  /tmp/create-order-resposta.json | base64 -D
```

Você deve ver `START RequestId`, depois as linhas `"step":"gravado"` e `"step":"enfileirado"`, e `REPORT` com a duração. `START` é o runtime dizendo que a função rodou.

Esse segundo invoke cria outro pedido. Use o `orderId` do arquivo de resposta que você acabou de gerar.

## Fase 4. Ler o item no DynamoDB

A chave é só `orderId`. O valor precisa ir no formato de atributo do DynamoDB (`S` = string).

```bash
aws dynamodb get-item --endpoint-url "$ENDPOINT" \
  --table-name orders \
  --key '{"orderId":{"S":"COLE-O-ORDER-ID"}}'
```

O `status` está `RECEIVED`. `trail` tem dois passos gravados pela própria função: o `PutItem` e o `SendMessage`. O preço total é `3000` centavos, R$ 30,00.

## Fase 5. Ler a mensagem na fila

```bash
QUEUE_URL=$(aws sqs get-queue-url --endpoint-url "$ENDPOINT" \
  --queue-name orders --query QueueUrl --output text)

aws sqs receive-message --endpoint-url "$ENDPOINT" \
  --queue-url "$QUEUE_URL" \
  --max-number-of-messages 1 \
  --visibility-timeout 0
```

O corpo é só `{"orderId":"..."}`. A fila não carrega o pedido; a outra Lambda busca o item pela chave. `--visibility-timeout 0` devolve a mensagem na hora, então ela continua visível.

## Fase 6. Ligar o consumidor de novo

```bash
aws lambda update-event-source-mapping --endpoint-url "$ENDPOINT" \
  --uuid COLE-O-UUID --enabled
```

Espere `State` voltar para `Enabled` no `list-event-source-mappings`. Em seguida a fila chama `process-order` sem você invocar essa função.

## Fase 7. Ver a decisão

Leia o mesmo item outra vez:

```bash
aws dynamodb get-item --endpoint-url "$ENDPOINT" \
  --table-name orders \
  --key '{"orderId":{"S":"COLE-O-ORDER-ID"}}'
```

`status` virou `CONFIRMED` e `trail` ganhou o passo `process-order`. O log dessa função está em outro grupo:

```bash
aws logs tail /aws/lambda/process-order --endpoint-url "$ENDPOINT" --since 10m
```

As linhas `decidido` e `atualizado` são o código. `START` e `REPORT` são o runtime. Os outros grupos são `/aws/lambda/create-order` e `/aws/lambda/get-order`.

Para ver uma recusa, repita da fase 3 com este `body`:

```json
{"customerName":"Bruno","items":[{"sku":"MESA","qty":1,"unitCents":60000}]}
```

60000 centavos são R$ 600,00, acima do limite de R$ 500,00. O item termina `REJECTED` com `reason` `total acima de R$ 500,00`. Quantidade `0` também recusa, com `quantidade inválida`.

Se quiser executar a decisão sem religar a fila, invoque `process-order` com o formato de evento do SQS. Troque o `orderId` por um pedido que ainda esteja `RECEIVED`:

```bash
cat > /tmp/process-order.json <<'EOF'
{
  "Records": [
    { "messageId": "manual", "body": "{\"orderId\":\"COLE-O-ORDER-ID\"}" }
  ]
}
EOF

aws lambda invoke --endpoint-url "$ENDPOINT" \
  --function-name process-order \
  --cli-binary-format raw-in-base64-out \
  --log-type Tail \
  --payload file:///tmp/process-order.json \
  /tmp/process-order-resposta.json
```

Chamar de novo o mesmo pedido imprime `ja-processado` e não muda a tabela: o `UpdateItem` só grava se o status ainda for `RECEIVED`.

## Fase 8. Passar pelo API Gateway

Aqui quem monta o evento da fase 3 é o API Gateway. Você manda HTTP.

```bash
curl -s -X POST "http://127.0.0.1:4566/restapis/${API_ID}/dev/_user_request_/orders" \
  -H 'content-type: application/json' \
  -d '{"customerName":"Ana","items":[{"sku":"CADERNO","qty":2,"unitCents":1500}]}'
```

A resposta já é o pedido, sem o envelope `statusCode`/`body`. Consulte em seguida:

```bash
curl -s "http://127.0.0.1:4566/restapis/${API_ID}/dev/_user_request_/orders/COLE-O-ORDER-ID"
```

Se o consumidor estiver ligado, o `curl` do GET pode já voltar `CONFIRMED`. O POST, na hora em que responde, ainda traz `RECEIVED`: a confirmação acontece depois, na fila.

A página em `http://127.0.0.1:5173` (`npm run ui`) faz esse POST e esse GET e acende o caminho conforme o status muda. Os comandos desta página são o que ela está chamando.
