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
const FRONTEND_URL = process.env.FRONTEND_URL;

// 检查必要的环境变量
if (!DEEPSEEK_API_KEY) {
  console.error('❌ 错误：缺少 DEEPSEEK_API_KEY 环境变量！');
}
if (!PADDLE_API_KEY) {
  console.error('❌ 错误：缺少 PADDLE_API_KEY 环境变量！');
}
if (!PADDLE_PRICE_ID) {
  console.error('❌ 错误：缺少 PADDLE_PRICE_ID 环境变量！');
}

if (!DEEPSEEK_API_KEY || !PADDLE_API_KEY || !PADDLE_PRICE_ID) {
  console.error('请设置所有必需的环境变量后重新部署');
  process.exit(1);
}

console.log('✅ DeepSeek API Key 已配置');
console.log('✅ Paddle API Key 已配置');
console.log('✅ Paddle Price ID 已配置');
console.log('✅ 前端域名:', FRONTEND_URL || '未设置（CORS 将允许所有来源）');

// CORS 配置
const corsOptions = FRONTEND_URL
  ? { origin: FRONTEND_URL, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }
  : { origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] };

app.use(cors(corsOptions));
app.use(express.json());

// ---- 简易数据库 (JSON 文件) ----
const DB_FILE = path.join(__dirname, 'orders.json');
function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('读数据库失败:', e);
  }
  return {};
}
function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('写数据库失败:', e);
  }
}

// ==========================================
// 接口1：生成中文名（免费部分）
// ==========================================
app.post('/api/generate', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] 📥 收到生成请求`);

  try {
    const { englishName, interest } = req.body;

    if (!englishName || englishName.trim() === '') {
      console.log('❌ 英文名为空');
      return res.status(400).json({ error: 'Please provide your English name.' });
    }

    console.log(`📝 英文名: ${englishName}, 兴趣: ${interest || '无'}`);

    // 构建 DeepSeek 提示词
    const systemPrompt = `You are a master of Chinese names and cultural storytelling. Output MUST be a strict JSON object:
{
  "chinese_name": "2-3 Chinese characters",
  "pinyin": "pronunciation with tones",
  "free_part": "short teaser under 80 words, end with 'But there is a much deeper story hidden behind these characters...'",
  "paid_part": "rich 200-300 word explanation with poetry origin, personality meaning, and personal connection"
}
Rules: authentic Chinese surname, poetic given name, paid_part must feel worth paying for, never reveal paid content in free_part. Output ONLY JSON.`;

    const userPrompt = `My English name is ${englishName}.${interest ? ' I love ' + interest + '.' : ''} Please give me a poetic Chinese name.`;

    console.log('🤖 正在调用 DeepSeek API...');

    // 调用 DeepSeek API
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
      console.error('❌ DeepSeek API 错误:', aiRes.status, errText);
      return res.status(500).json({
        error: 'AI generation failed',
        details: `DeepSeek API returned ${aiRes.status}: ${errText.substring(0, 200)}`
      });
    }

    const aiData = await aiRes.json();
    console.log('✅ DeepSeek 响应成功');

    // 解析 AI 返回的 JSON
    let result;
    try {
      result = JSON.parse(aiData.choices[0].message.content);
    } catch (parseError) {
      console.error('❌ 解析 AI 响应失败:', parseError);
      return res.status(500).json({
        error: 'Failed to parse AI response',
        details: parseError.message
      });
    }

    // 验证必要字段
    if (!result.chinese_name || !result.pinyin || !result.free_part || !result.paid_part) {
      console.error('❌ AI 响应缺少必要字段:', result);
      return res.status(500).json({
        error: 'AI response missing required fields',
        details: 'Missing chinese_name, pinyin, free_part, or paid_part'
      });
    }

    // 生成订单 ID
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

    const elapsed = Date.now() - startTime;
    console.log(`✅ 生成成功！订单: ${orderId}, 耗时: ${elapsed}ms`);

    res.json({
      orderId,
      chinese_name: result.chinese_name,
      pinyin: result.pinyin,
      free_part: result.free_part
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ 生成错误 (${elapsed}ms):`, error);
    // 确保总是返回响应
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Something went wrong',
        details: error.message
      });
    }
  }
});

// ==========================================
// 接口2：创建 Paddle 支付链接
// ==========================================
app.post('/api/create-checkout', async (req, res) => {
  console.log(`[${new Date().toISOString()}] 📥 收到支付创建请求`);

  try {
    const { orderId } = req.body;

    if (!orderId) {
      console.log('❌ 缺少 orderId');
      return res.status(400).json({ error: 'Missing orderId' });
    }

    const db = readDB();
    const order = db[orderId];

    if (!order) {
      console.log(`❌ 订单不存在: ${orderId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!FRONTEND_URL) {
      console.error('❌ FRONTEND_URL 未设置，无法创建支付链接');
      return res.status(500).json({ error: 'Frontend URL not configured' });
    }

    console.log(`🛒 创建支付链接，订单: ${orderId}`);

    const successUrl = `${FRONTEND_URL}?orderId=${orderId}&paid=true`;
    console.log(`🔗 成功跳转地址: ${successUrl}`);

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
          success_url: successUrl,
          allow_coupons: false
        }
      })
    });

    const data = await checkoutRes.json();

    if (!data.data?.url) {
      console.error('❌ Paddle 错误:', JSON.stringify(data));
      return res.status(500).json({
        error: 'Failed to create checkout',
        details: data.error?.detail || 'Unknown error'
      });
    }

    console.log(`✅ 支付链接创建成功: ${data.data.url}`);
    res.json({ url: data.data.url });

  } catch (error) {
    console.error('❌ 创建支付错误:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Checkout creation failed',
        details: error.message
      });
    }
  }
});

// ==========================================
// 接口3：获取付费故事
// ==========================================
app.get('/api/get-story/:orderId', (req, res) => {
  const { orderId } = req.params;
  console.log(`[${new Date().toISOString()}] 📥 获取故事: ${orderId}`);

  try {
    const db = readDB();
    const order = db[orderId];

    if (!order) {
      console.log(`❌ 订单不存在: ${orderId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.paid) {
      console.log(`⏳ 订单未支付: ${orderId}`);
      return res.status(403).json({ error: 'Not paid yet' });
    }

    console.log(`✅ 返回付费故事: ${orderId}`);
    res.json({
      chinese_name: order.result.chinese_name,
      pinyin: order.result.pinyin,
      paid_part: order.result.paid_part
    });

  } catch (error) {
    console.error('❌ 获取故事错误:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get story' });
    }
  }
});

// ==========================================
// Webhook：Paddle 支付通知
// ==========================================
app.post('/api/webhook', (req, res) => {
  console.log(`[${new Date().toISOString()}] 📥 收到 Webhook 通知`);

  try {
    const event = req.body;
    console.log(`📋 事件类型: ${event.event_type}`);

    if (event.event_type === 'transaction.completed') {
      const orderId = event.data?.custom_data?.order_id;

      if (orderId) {
        const db = readDB();
        if (db[orderId]) {
          db[orderId].paid = true;
          db[orderId].paidAt = new Date().toISOString();
          writeDB(db);
          console.log(`✅ 支付成功！订单: ${orderId}`);
        } else {
          console.log(`⚠️ 订单不存在: ${orderId}`);
        }
      } else {
        console.log('⚠️ Webhook 中未找到 order_id');
      }
    } else {
      console.log(`ℹ️ 忽略事件: ${event.event_type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('❌ Webhook 处理错误:', error);
    // 仍然返回 200，避免 Paddle 重试
    res.json({ received: true, error: error.message });
  }
});

// ==========================================
// 健康检查
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    frontend_url: FRONTEND_URL || '未设置'
  });
});

// ==========================================
// 启动服务器
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`🌐 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`📦 前端域名: ${FRONTEND_URL || '未设置'}`);
});
