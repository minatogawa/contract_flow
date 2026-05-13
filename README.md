# ContractFlow Demo

Demo local com login, upload de PDFs, busca de trechos por pagina, resposta por LLM e Mercado Pago Checkout Pro.

## Rodar

Requer Node.js 24 ou superior.

```powershell
npm start
```

Acesse:

- Landing: http://localhost:3140
- Demo: http://localhost:3140/app

## Rodar com Docker

Copie `.env.example` para `.env` e ajuste as credenciais. Depois:

```powershell
docker compose up --build
```

Por padrao o container expoe:

- Landing: http://localhost:3140
- Demo: http://localhost:3140/app

Para trocar a porta publicada no host, ajuste `HOST_PORT` no `.env`. Os dados locais do app ficam persistidos no volume Docker `contractflow-data`.

## Persistencia

Os metadados ficam em SQLite em `data/app.db`, e os PDFs continuam em `data/uploads/`. Ao iniciar, se `data/app.db` ainda estiver vazio e existir um `data/db.json` antigo, o app importa esse JSON automaticamente uma vez.

## Deploy no Fly.io

O app usa SQLite, entao precisa de volume persistente em `/app/data` e deve comecar com uma unica Machine.

Instale e autentique o `flyctl`, depois:

```powershell
fly launch --copy-config --no-deploy
fly volumes create contractflow_data --size 1 --region gru
fly secrets set APP_URL=https://contract-flow.fly.dev SESSION_SECRET=troque-por-uma-string-grande
fly secrets set LLM_PROVIDER=gemini GEMINI_API_KEY=sua_key GEMINI_MODEL=gemini-2.5-flash
fly secrets set MP_ACCESS_TOKEN=TEST-... MP_PUBLIC_KEY=TEST-... MP_CHECKOUT_MODE=sandbox
fly deploy
fly status
```

Se voce escolher outro nome para o app, ajuste `app` em `fly.toml` e use esse mesmo nome em `APP_URL`.

## Configurar IA

Edite `.env`:

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=sua_key
GEMINI_MODEL=gemini-2.5-flash
```

Ou DeepSeek:

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sua_key
DEEPSEEK_MODEL=deepseek-v4-flash
```

Se a chamada ao provedor falhar, o app cai em modo mock e responde com base no melhor trecho encontrado.

## Configurar Mercado Pago

Preencha:

```env
MP_ACCESS_TOKEN=TEST-...
MP_PUBLIC_KEY=TEST-...
MP_CHECKOUT_MODE=sandbox
MP_PREMIUM_AMOUNT=249000
MP_PREMIUM_CURRENCY=CLP
MP_PREMIUM_TITLE=ContractFlow Premium
```

Para producao, use credenciais de producao e:

```env
MP_CHECKOUT_MODE=production
```

Mercado Pago precisa de URL publica HTTPS para `back_urls` e `notification_url`. Em ambiente local, use um tunel como ngrok e ajuste `APP_URL`:

```env
APP_URL=https://seu-tunel.ngrok-free.app
```

Quando o Mercado Pago confirma um pagamento `approved`, o usuario vira `premium`. O app tambem tenta sincronizar pagamentos pendentes ao carregar a area logada, o que ajuda em testes locais sem webhook publico.

## Limites gratis

```env
FREE_QUESTION_LIMIT=30
FREE_DOCUMENT_LIMIT=10
```

Quando o limite e atingido, o frontend abre o paywall e chama o Checkout Pro do Mercado Pago.

## Observacao sobre PDFs

O extrator embutido funciona melhor com PDFs pesquisaveis. PDFs escaneados precisam de OCR para virar texto.
