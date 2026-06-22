require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 10000;
const BASE = process.env.SYNC_BASE_URL || 'https://api.syncpayments.com.br';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =============================================
// CACHE DO TOKEN
// =============================================
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const agora = Date.now();
  if (cachedToken && agora < tokenExpiresAt - 60_000) return cachedToken;

  const res = await axios.post(`${BASE}/api/partner/v1/auth-token`, {
    client_id:     process.env.SYNC_CLIENT_ID,
    client_secret: process.env.SYNC_CLIENT_SECRET,
  }, { headers: { 'Content-Type': 'application/json' } });

  cachedToken    = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in * 1000);
  console.log('[Sync] Novo token gerado. Expira em:', new Date(tokenExpiresAt).toISOString());
  return cachedToken;
}

// =============================================
// POST /api/criar-pix
// client é OPCIONAL — usa dados genéricos se não vier
// =============================================
app.post('/api/criar-pix', async (req, res) => {
  try {
    const { amount, client } = req.body;

    if (!amount || amount < 5) {
      return res.status(422).json({ error: 'Valor mínimo de R$ 5,00.' });
    }

    // Dados do doador — usa genérico se não informado
    const nome  = client?.name  || 'Doador Anonimo';
    const cpf   = client?.cpf   || '00000000000';
    const email = client?.email || 'doador@abrigo.com';
    const phone = client?.phone || '11000000000';

    const token = await getAccessToken();

    const payload = {
      amount:      Number(amount),
      description: 'Doacao Abrigo Sao Francisco',
      webhook_url: `${process.env.PUBLIC_URL}/webhook`,
      client: { name: nome, cpf, email, phone },
    };

    const syncRes = await axios.post(`${BASE}/api/partner/v1/cash-in`, payload, {
      headers: {
        'Content-Type':  'application/json',
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
    if (status === 401) { cachedToken = null; tokenExpiresAt = 0; }
    return res.status(status).json({ error: message });
  }
});

// =============================================
// GET /api/status/:identifier
// =============================================
app.get('/api/status/:identifier', async (req, res) => {
  try {
    const token = await getAccessToken();
    const syncRes = await axios.get(
      `${BASE}/api/partner/v1/transaction/${req.params.identifier}`,
      { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` } }
    );
    const { status, amount, transaction_date } = syncRes.data.data;
    return res.json({ status, amount, transaction_date });
  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message;
    if (status === 401) { cachedToken = null; tokenExpiresAt = 0; }
    return res.status(status).json({ error: message });
  }
});

// =============================================
// POST /webhook
// =============================================
app.post('/webhook', (req, res) => {
  console.log('[Webhook] Recebido:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🐾 Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Sync Base URL : ${BASE}`);
  console.log(`   Webhook URL   : ${process.env.PUBLIC_URL}/webhook\n`);
});
