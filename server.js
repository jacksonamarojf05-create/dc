require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = process.env.SYNC_BASE_URL || 'https://api.syncpayments.com.br';

app.use(cors());
app.use(express.json());

// Serve os arquivos estáticos da página (HTML, CSS, imagens, JS)
app.use(express.static(path.join(__dirname)));

// =============================================
// CACHE DO TOKEN (evita gerar um novo por req)
// =============================================
let cachedToken    = null;
let tokenExpiresAt = 0; // timestamp em ms

async function getAccessToken() {
  const agora = Date.now();

  // Reusa o token se ainda válido (com margem de 60s)
  if (cachedToken && agora < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const res = await axios.post(`${BASE}/api/partner/v1/auth-token`, {
    client_id:     process.env.SYNC_CLIENT_ID,
    client_secret: process.env.SYNC_CLIENT_SECRET,
  }, {
    headers: { 'Content-Type': 'application/json' },
  });

  cachedToken    = res.data.access_token;
  // expires_in vem em segundos
  tokenExpiresAt = agora + (res.data.expires_in * 1000);

  console.log('[Sync] Novo token gerado. Expira em:', new Date(tokenExpiresAt).toISOString());
  return cachedToken;
}

// =============================================
// POST /api/criar-pix
// Body: { amount, client: { name, cpf, email, phone } }
// =============================================
app.post('/api/criar-pix', async (req, res) => {
  try {
    const { amount, client } = req.body;

    // Validação básica no backend
    if (!amount || amount <= 0) {
      return res.status(422).json({ error: 'Valor inválido.' });
    }
    if (!client?.name || !client?.cpf || !client?.email || !client?.phone) {
      return res.status(422).json({ error: 'Dados do cliente incompletos.' });
    }
    if (!/^\d{11}$/.test(client.cpf)) {
      return res.status(422).json({ error: 'CPF deve conter exatamente 11 dígitos numéricos.' });
    }
    if (!/^\d{10,11}$/.test(client.phone)) {
      return res.status(422).json({ error: 'Telefone deve conter 10 ou 11 dígitos numéricos (com DDD).' });
    }

    const token = await getAccessToken();

    const webhookUrl = `${process.env.PUBLIC_URL}/webhook`;

    const payload = {
      amount:      Number(amount),
      description: 'Doacao Abrigo Sao Francisco',
      webhook_url: webhookUrl,
      client: {
        name:  client.name,
        cpf:   client.cpf,
        email: client.email,
        phone: client.phone,
      },
    };

    const syncRes = await axios.post(`${BASE}/api/partner/v1/cash-in`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept':        'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    const { pix_code, identifier } = syncRes.data;

    console.log(`[Sync] PIX criado — identifier: ${identifier} | amount: R$ ${amount}`);

    return res.json({ pix_code, identifier });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message || 'Erro interno ao gerar PIX.';

    console.error('[Sync] Erro ao criar PIX:', status, message, err.response?.data);

    // Se token expirou, limpa o cache para forçar renovação na próxima chamada
    if (status === 401) {
      cachedToken    = null;
      tokenExpiresAt = 0;
    }

    return res.status(status).json({ error: message });
  }
});

// =============================================
// GET /api/status/:identifier
// Consulta o status da transação na Sync
// =============================================
app.get('/api/status/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    const token = await getAccessToken();

    const syncRes = await axios.get(
      `${BASE}/api/partner/v1/transaction/${identifier}`,
      {
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    const { status, amount, transaction_date } = syncRes.data.data;

    return res.json({ status, amount, transaction_date });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message || 'Erro ao consultar status.';

    console.error('[Sync] Erro ao consultar status:', status, message);

    if (status === 401) {
      cachedToken    = null;
      tokenExpiresAt = 0;
    }

    return res.status(status).json({ error: message });
  }
});

// =============================================
// POST /webhook
// Recebe notificações de atualização da Sync
// =============================================
app.post('/webhook', (req, res) => {
  const payload = req.body;
  console.log('[Webhook] Recebido:', JSON.stringify(payload, null, 2));

  // Retorna 200 imediatamente (Sync tem timeout de 5s nos webhooks)
  res.sendStatus(200);
});

// =============================================
// Fallback: serve o HTML para qualquer rota
// =============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🐾 Servidor Abrigo São Francisco rodando em http://localhost:${PORT}`);
  console.log(`   Sync Base URL: ${BASE}`);
  console.log(`   Webhook URL:   ${process.env.PUBLIC_URL}/webhook\n`);
});
