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
      [{ text: '🗑 Сброс дня' }],
    ],
    resize_keyboard: true,
  },
};

const confirmResetKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '✅ Да, сбросить' }, { text: '❌ Нет' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

// Храним данные в памяти (сбрасывается при перезапуске бота)
let todayStr = new Date().toDateString();
let feedings = []; // { start: Date, end: Date, ml: number }
let currentStart = null; // Date или null
let waitingMl = false; // ждём, что пользователь пришлёт число мл
let waitingResetConfirm = false;
let prevUserMessageId = null;
let prevBotMessageId = null;

function ensureToday() {
  const nowStr = new Date().toDateString();
  if (nowStr !== todayStr) {
    todayStr = nowStr;
    feedings = [];
    currentStart = null;
    waitingMl = false;
    waitingResetConfirm = false;
  }
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function deleteIfExists(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  } catch (e) {}
}

async function sendAndRotate(chatId, text, extra = {}) {
  // удаляем старую пару, чтобы не было мусора, но оставалась "текущая" переписка
  await deleteIfExists(chatId, prevUserMessageId);
  await deleteIfExists(chatId, prevBotMessageId);

  const sent = await bot.sendMessage(chatId, text, { ...mainKeyboard, ...extra });
  prevBotMessageId = sent.message_id;
  // prevUserMessageId обновится после обработки текущего сообщения пользователя
}

bot.onText(/\/start/, async (msg) => {
  ensureToday();
  const chatId = msg.chat.id;
  prevUserMessageId = msg.message_id;
  await sendAndRotate(
    chatId,
    'Привет! Я помогу записывать кормления.\n\n' +
      'Кнопки внизу:\n' +
      '▶️ Начать кормление — когда начали\n' +
      '⏹ Закончить кормление — потом напиши, сколько мл съела дочка\n' +
      '📊 Сегодня — сколько кормлений и всего мл за сегодня\n' +
      '🗑 Сброс дня — очистить записи за сегодня (с подтверждением)'
  );
});

bot.on('message', async (msg) => {
  ensureToday();
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Игнорируем служебные обновления без текста в обычном смысле
  if (!text) return;
  if (text.startsWith('/start')) return; // уже обработано в onText

  // Подтверждение сброса дня
  if (waitingResetConfirm) {
    prevUserMessageId = msg.message_id;
    if (text === '✅ Да, сбросить') {
      feedings = [];
      currentStart = null;
      waitingMl = false;
      waitingResetConfirm = false;
      await sendAndRotate(chatId, 'День сброшен. Записи за сегодня очищены.');
      return;
    }
    if (text === '❌ Нет') {
      waitingResetConfirm = false;
      await sendAndRotate(chatId, 'Сброс отменён.');
      return;
    }
    await sendAndRotate(chatId, 'Нажми «✅ Да, сбросить» или «❌ Нет».', confirmResetKeyboard);
    return;
  }

  // Если ждём число мл после "Закончить"
  if (waitingMl) {
    prevUserMessageId = msg.message_id;
    const ml = Number(text.replace(',', '.'));
    if (!Number.isFinite(ml) || ml <= 0) {
      await sendAndRotate(chatId, 'Напиши, пожалуйста, сколько мл съела дочка (только число), например: 120');
      return;
    }
    const endTime = new Date();
    const startTime = currentStart;
    feedings.push({ start: startTime, end: endTime, ml });
    currentStart = null;
    waitingMl = false;

    const totalMl = feedings.reduce((sum, f) => sum + f.ml, 0);
    await sendAndRotate(
      chatId,
      `Записано: ${ml} мл (кормление с ${formatTime(startTime)} до ${formatTime(endTime)}).\n` +
        `Сегодня: ${feedings.length} кормлений, всего ${totalMl} мл.`
    );
    return;
  }

  prevUserMessageId = msg.message_id;

  if (text === '▶️ Начать кормление') {
    if (currentStart) {
      await sendAndRotate(
        chatId,
        `У тебя уже есть незакончённое кормление (началось в ${formatTime(currentStart)}). Сначала нажми ⏹ Закончить кормление и укажи, сколько мл.`
      );
      return;
    }
    currentStart = new Date();
    await sendAndRotate(chatId, `Кормление началось в ${formatTime(currentStart)}. Когда закончите — нажми ⏹ Закончить кормление.`);
    return;
  }

  if (text === '⏹ Закончить кормление') {
    if (!currentStart) {
      await sendAndRotate(chatId, 'Сейчас нет начатого кормления. Сначала нажми ▶️ Начать кормление.');
      return;
    }
    waitingMl = true;
    await sendAndRotate(chatId, 'Сколько мл съела дочка? Напиши число (например, 120).');
    return;
  }

  if (text === '📊 Сегодня') {
    const totalMl = feedings.reduce((sum, f) => sum + f.ml, 0);
    await sendAndRotate(chatId, `Сегодня: ${feedings.length} кормлений, всего ${totalMl} мл.`);
    return;
  }

  if (text === '🗑 Сброс дня') {
    waitingResetConfirm = true;
    await sendAndRotate(chatId, 'Точно сбросить все записи за сегодня? Это нельзя отменить.', confirmResetKeyboard);
    return;
  }

  // Любое другое сообщение
  await sendAndRotate(chatId, 'Нажми кнопку внизу: ▶️ Начать, ⏹ Закончить, 📊 Сегодня или 🗑 Сброс дня.');
});

console.log('Бот запущен...');