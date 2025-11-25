const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// 🔐 Переменные из Render Environment
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = [935264202, 1527919229];

// 🛡️ Инициализация Supabase с защитой от ошибок
let supabase = null;

try {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL не задан');
  }
  if (!supabaseKey) {
    throw new Error('SUPABASE_ANON_KEY не задан или пуст');
  }

  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Supabase успешно инициализирован');
} catch (err) {
  console.error('❌ Ошибка инициализации Supabase:', err.message);
  process.exit(1);
}

// 📤 Отправка сообщения в Telegram
async function sendText(chatId, text, replyMarkup = null) {
  if (!TOKEN) {
    console.error('❌ BOT_TOKEN не задан в Render Environment Variables');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Telegram API ошибка:', errorText);
    }
  } catch (err) {
    console.error('💥 Ошибка отправки в Telegram:', err.message);
  }
}

// 💾 Сохранение сотрудника
async function saveEmployee(chatId, name, type) {
  if (!supabase) return;
  if (typeof chatId !== 'number' || isNaN(chatId) || chatId <= 0) return;
  if (!name || typeof name !== 'string') name = 'Аноним';
  if (!['military', 'civil'].includes(type)) return;

  try {
    await supabase
      .from('employees')
      .upsert({ chat_id: chatId, name, type }, { onConflict: 'chat_id' });
  } catch (err) {
    console.error('💥 Ошибка сохранения в Supabase:', err.message);
  }
}

// 📢 Рассылка
async function sendBroadcast(text, type) {
  if (!supabase) return { sent: 0 };
  try {
    let query = supabase.from('employees').select('chat_id');
    if (type !== 'all') {
      query = query.eq('type', type);
    }
    const { data, error } = await query;
    if (error) {
      console.error('❌ Supabase select error:', error);
      return { sent: 0 };
    }

    let sent = 0;
    for (const { chat_id } of data || []) {
      await sendText(chat_id, text);
      sent++;
    }
    return { sent };
  } catch (err) {
    console.error('💥 Ошибка рассылки:', err.message);
    return { sent: 0 };
  }
}

// 🧠 Обработчик запросов от Telegram
async function handleRequest(body) {
  const { message, callback_query } = body;

  if (message?.text) {
    const chatId = Number(message.chat.id);
    const text = message.text.trim();

    // Админ вводит текст рассылки
    if (ADMIN_CHAT_IDS.includes(chatId) && supabase) {
      const { data: session, error } = await supabase
        .from('admin_sessions')
        .select('awaiting_broadcast_type')
        .eq('chat_id', chatId)
        .single();

      if (!error && session?.awaiting_broadcast_type) {
        await supabase.from('admin_sessions').delete().eq('chat_id', chatId);
        const result = await sendBroadcast(text, session.awaiting_broadcast_type);
        await sendText(chatId, `✅ Рассылка отправлена!\n📤 Получателей: ${result.sent}`);
        return;
      }

      // Команды
      if (text === '/start') {
        const keyboard = {
          inline_keyboard: [
            [{ text: '🎖️ Военный', callback_data: 'type_military' }],
            [{ text: '👔 Гражданский', callback_data: 'type_civil' }],
          ],
        };
        await sendText(chatId, '👋 Привет! Пожалуйста, выберите ваш тип:', keyboard);
        return;
      }

      if (text === '/menu' && ADMIN_CHAT_IDS.includes(chatId)) {
        const keyboard = {
          inline_keyboard: [
            [{ text: '📤 Отправить ВСЕМ', callback_data: 'send_all' }],
            [{ text: '🎖️ Только военным', callback_data: 'send_military' }],
            [{ text: '👔 Только гражданским', callback_data: 'send_civil' }],
          ],
        };
        await sendText(chatId, '👇 Выберите тип рассылки:', keyboard);
        return;
      }
    }
  }

  if (callback_query) {
    const callbackId = callback_query.id;
    const chatId = Number(callback_query.message?.chat?.id) || callback_query.from.id;
    const userId = callback_query.from.id;
    const data = callback_query.data;
    const name = callback_query.from.first_name || callback_query.from.username || 'Аноним';

    // ✅ Ответ на callback (убрать часики)
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId }),
      });
    } catch (e) {
      console.warn('⚠️ Не удалось ответить на callback');
    }

    // Выбор типа
    if (['type_military', 'type_civil'].includes(data)) {
      const type = data === 'type_military' ? 'military' : 'civil';
      await saveEmployee(chatId, name, type);
      await sendText(chatId, `✅ Вы выбрали: ${type === 'military' ? 'Военный' : 'Гражданский'}.`);
      return;
    }

    // Админские кнопки
    if (ADMIN_CHAT_IDS.includes(userId)) {
      if (['send_all', 'send_military', 'send_civil'].includes(data)) {
        const type = data.replace('send_', '');
        if (supabase) {
          await supabase
            .from('admin_sessions')
            .upsert({ chat_id: userId, awaiting_broadcast_type: type }, { onConflict: 'chat_id' });
        }
        const typeMap = { all: 'всем', military: 'военным', civil: 'гражданским' };
        await sendText(userId, `📩 Введите текст рассылки для: ${typeMap[type]}\n(Просто отправьте текст в чат)`);
        return;
      }
    }
  }
}

// 🚀 Запуск HTTP-сервера
const PORT = process.env.PORT || 10000;
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body);
        await handleRequest(json);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('💥 Ошибка обработки запроса:', err.message);
        res.writeHead(200); // Telegram требует 200 даже при ошибках
        res.end(JSON.stringify({ ok: true }));
      }
    });
  } else {
    // Для проверки в браузере
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('✅ Telegram bot is running');
  }
});

// Слушаем на 0.0.0.0 — обязательно для Render!
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Бот запущен на порту ${PORT}`);
});

