const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// ==========================================
// 所有密钥从环境变量读取（安全）
// ==========================================
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID;
// FRONTEND_URL 可选，用于 CORS 白名单，若未设置则允许所有来源（仅开发测试）
const FRONTEND_URL = process.env.FRONTEND_URL;

// 检查必要的环境变量
if (!DEEPSEEK_API_KEY || !PADDLE_API_KEY || !PADDLE_PRICE_ID) {
  console.error('❌ 错误：缺少必要的环境变量！');
  console.error('请设置：DEEPSEEK_API_KEY, PADDLE_API_KEY, PADDLE_PRICE_ID');
  process.exit(1);
}

// CORS 配置：如果设置了 FRONTEND_URL 则使用，否则允许所有（开发模式）
const corsOptions = FRONTEND_URL
  ? { origin: FRONTEND_URL, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }
  : { origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] };

app.use(cors(corsOptions));
if (!FRONTEND_URL) {
  console.warn('⚠️ 警告：FRONTEND_URL 未设置，CORS 允许所有来源，生产环境请务必设置！');
}

app.use(express.json());

// ---- 简易数据库 (JSON 文件) ----
const DB_FILE = path.join(__dirname, 'orders.json');
function readDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return {};
}
function writeDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

// ===== 接口1：生成中文名 =====
app.post('/api/generate', async (req, res) => {
  try {
    const { englishName, interest } = req.body;
    if (!englishName || englishName.trim() === '') {
      return res.status(400).json({ error: 'Please provide your English name.' });
    }

    const systemPrompt = `You are a master of Chinese names and cultural storytelling. Output MUST be a strict JSON object:
{
  "chinese_name": "2-3 Chinese characters",
  "pinyin": "pronunciation with tones",
  "free_part": "short teaser under 80 words, end with 'But there is a much deeper story hidden behind these characters...'",
  "paid_part": "rich 200-300 word explanation with poetry origin, personality meaning, and personal connection"
}
Rules: authentic Chinese surname, poetic given name, paid_part must feel worth paying for, never reveal paid content in free_part. Output ONLY JSON.`;

    const userPrompt = `My English name is ${englishName}.${interest ? ' I love ' + interest + '.' : ''} Please give me a poetic Chinese name.`;

    const aiRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1000,
        temperature: 0.9
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('DeepSeek 错误:', errText);
      return res.status(500).json({ error: 'AI generation failed' });
    }

    const aiData = await aiRes.json();
    const result = JSON.parse(aiData.choices[0].message.content);

    const orderId = crypto.randomUUID();
    const db = readDB();
    db[orderId] = {
      englishName,
      interest: interest || '',
      result,
      paid: false,
      createdAt: new Date().toISOString()
    };
    writeDB(db);

    res.json({
      orderId,
      chinese_name: result.chinese_name,
      pinyin: result.pinyin,
      free_part: result.free_part
    });

  } catch (error) {
    console.error('生成错误:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ===== 接口2：创建 Paddle 支付链接 =====
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const db = readDB();
    if (!db[orderId]) return res.status(404).json({ error: 'Order not found' });

    const checkoutRes = await fetch('https://api.paddle.com/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PADDLE_API_KEY}`
      },
      body: JSON.stringify({
        items: [{ price_id: PADDLE_PRICE_ID, quantity: 1 }],
        custom_data: { order_id: orderId },
        settings: {
          success_url: `${FRONTEND_URL || 'https://your-frontend.vercel.app'}?orderId=${orderId}&paid=true`,
          allow_coupons: false
        }
      })
    });

    const data = await checkoutRes.json();
    if (!data.data?.url) {
      console.error('Paddle 错误:', JSON.stringify(data));
      return res.status(500).json({ error: 'Failed to create checkout' });
    }

    res.json({ url: data.data.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout creation failed' });
  }
});

// ===== 接口3：获取付费故事 =====
app.get('/api/get-story/:orderId', (req, res) => {
  const { orderId } = req.params;
  const db = readDB();
  const order = db[orderId];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.paid) return res.status(403).json({ error: 'Not paid yet' });

  res.json({
    chinese_name: order.result.chinese_name,
    pinyin: order.result.pinyin,
    paid_part: order.result.paid_part
  });
});

// ===== Webhook：Paddle 支付通知 =====
app.post('/api/webhook', (req, res) => {
  const event = req.body;
  if (event.event_type === 'transaction.completed') {
    const orderId = event.data.custom_data?.order_id;
    if (orderId) {
      const db = readDB();
      if (db[orderId]) {
        db[orderId].paid = true;
        db[orderId].paidAt = new Date().toISOString();
        writeDB(db);
        console.log(`✅ 支付成功！订单: ${orderId}`);
      }
    }
  }
  res.json({ received: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 服务器运行在端口 ${PORT}`));
