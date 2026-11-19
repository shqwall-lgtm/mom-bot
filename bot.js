require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;

const options = { polling: true };
if (proxy) {
  options.request = { proxy };
}

const bot = new TelegramBot(token, options);

bot.on('polling_error', (err) => {
  console.log('polling_error:', err.code, err.message || err);
});

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '▶️ Начать кормление' }],
      [{ text: '⏹ Закончить кормление' }],
      [{ text: '📊 Сегодня' }],
    ],
    resize_keyboard: true,
  },
};

// Храним данные в памяти (сбрасывается при перезапуске бота)
let todayStr = new Date().toDateString();
let feedings = []; // { start: Date, end: Date, ml: number }
let currentStart = null; // Date или null
let waitingMl = false; // ждём, что пользователь пришлёт число мл
let lastBotMessageId = null;

function ensureToday() {
  const nowStr = new Date().toDateString();
  if (nowStr !== todayStr) {
    todayStr = nowStr;
    feedings = [];
    currentStart = null;
    waitingMl = false;
  }
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function sendOnlyLast(chatId, text, extra = {}) {
  try {
    if (lastBotMessageId) {
      await bot.deleteMessage(chatId, lastBotMessageId).catch(() => {});
    }
  } catch (e) {}
  const sent = await bot.sendMessage(chatId, text, { ...mainKeyboard, ...extra });
  lastBotMessageId = sent.message_id;
}

async function tryDeleteUserMessage(msg) {
  try {
    if (msg && msg.message_id && msg.chat && msg.chat.id) {
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }
  } catch (e) {}
}

bot.onText(/\/start/, async (msg) => {
  ensureToday();
  const chatId = msg.chat.id;
  await tryDeleteUserMessage(msg);
  await sendOnlyLast(
    chatId,
    'Привет! Я помогу записывать кормления.\n\n' +
      'Кнопки внизу:\n' +
      '▶️ Начать кормление — когда начали\n' +
      '⏹ Закончить кормление — потом напиши, сколько мл съела дочка\n' +
      '📊 Сегодня — сколько кормлений и всего мл за сегодня'
  );
});

bot.on('message', async (msg) => {
  ensureToday();
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Игнорируем служебные обновления без текста в обычном смысле
  if (!text) return;
  if (text.startsWith('/start')) return; // уже обработано в onText

  // Если ждём число мл после "Закончить"
  if (waitingMl) {
    await tryDeleteUserMessage(msg);
    const ml = Number(text.replace(',', '.'));
    if (!Number.isFinite(ml) || ml <= 0) {
      await sendOnlyLast(chatId, 'Напиши, пожалуйста, сколько мл съела дочка (только число), например: 120');
      return;
    }
    const endTime = new Date();
    const startTime = currentStart;
    feedings.push({ start: startTime, end: endTime, ml });
    currentStart = null;
    waitingMl = false;

    const totalMl = feedings.reduce((sum, f) => sum + f.ml, 0);
    await sendOnlyLast(
      chatId,
      `Записано: ${ml} мл (кормление с ${formatTime(startTime)} до ${formatTime(endTime)}).\n` +
        `Сегодня: ${feedings.length} кормлений, всего ${totalMl} мл.`
    );
    return;
  }

  await tryDeleteUserMessage(msg);

  if (text === '▶️ Начать кормление') {
    if (currentStart) {
      await sendOnlyLast(
        chatId,
        `У тебя уже есть незакончённое кормление (началось в ${formatTime(currentStart)}). Сначала нажми ⏹ Закончить кормление и укажи, сколько мл.`
      );
      return;
    }
    currentStart = new Date();
    await sendOnlyLast(chatId, `Кормление началось в ${formatTime(currentStart)}. Когда закончите — нажми ⏹ Закончить кормление.`);
    return;
  }

  if (text === '⏹ Закончить кормление') {
    if (!currentStart) {
      await sendOnlyLast(chatId, 'Сейчас нет начатого кормления. Сначала нажми ▶️ Начать кормление.');
      return;
    }
    waitingMl = true;
    await sendOnlyLast(chatId, 'Сколько мл съела дочка? Напиши число (например, 120).');
    return;
  }

  if (text === '📊 Сегодня') {
    const totalMl = feedings.reduce((sum, f) => sum + f.ml, 0);
    await sendOnlyLast(chatId, `Сегодня: ${feedings.length} кормлений, всего ${totalMl} мл.`);
    return;
  }

  // Любое другое сообщение
  await sendOnlyLast(chatId, 'Нажми кнопку внизу: ▶️ Начать, ⏹ Закончить или 📊 Сегодня.');
});

console.log('Бот запущен...');