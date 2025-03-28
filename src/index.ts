import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as dotenv from "dotenv";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
dotenv.config();

const connection = new Connection(process.env.RPC_URL!, "confirmed");
const wallet = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATEKEY!)
);

// Types for user data
interface UserData {
  token?: string;
  sol_balance: number;
  token_balance: number;
  step: "idle" | "awaiting_wallet" | "awaiting_buy" | "awaiting_sell";
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });

// Simple in-memory storage
const users: Record<number, UserData> = {};

// Start command
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from!.id;
  const balance = await connection.getBalance(wallet.publicKey);
  users[userId] = {
    sol_balance: balance,
    token_balance: 0,
    step: "awaiting_wallet",
  };
  bot.sendMessage(userId, "Welcome! Set token address:");
});

// Handle text messages (wallet setup, buy, and sell)
bot.on("message", async (msg) => {
  const userId = msg.from!.id;
  const user = users[userId] || {
    sol_balance: 0,
    token_balance: 0,
    step: "idle",
  };

  if (user.step === "awaiting_wallet") {
    user.token = msg.text!;
    user.step = "idle";
    return bot.sendMessage(
      userId,
      "Token address saved! What would you like to do?",
      {
        reply_markup: {
          keyboard: [
            [{ text: "➕ Add New Token" }],
            [{ text: "💰 Buy Token" }, { text: "💸 Sell Token" }],
            [{ text: "📊 Check Balance" }],
          ],
          resize_keyboard: true,
        },
      }
    );
  }

  if (user.step === "awaiting_buy") {
    const amount = parseFloat(msg.text!);
    if (isNaN(amount))
      return bot.sendMessage(userId, "Please send a valid number");

    if (!user.token)
      return bot.sendMessage(userId, "You need to set up your wallet first!");
    const token_balance = await getTokenBalance(
      wallet.publicKey,
      new PublicKey(user.token!)
    );
    const sol_balance = await connection.getBalance(wallet.publicKey);
    user.token_balance = token_balance;
    user.sol_balance = sol_balance;

    if (user.sol_balance < amount)
      return bot.sendMessage(
        userId,
        "You don't have enough SOL to buy this amount!"
      );

    try {
      // Call your buyCrypto function here
      await buyCrypto(user.token, amount * 1000000000);
      user.step = "idle";
      user.token_balance = await getTokenBalance(
        wallet.publicKey,
        new PublicKey(user.token!)
      );
      user.sol_balance = await connection.getBalance(wallet.publicKey);
      return bot.sendMessage(userId, `✅ Successfully swap ${amount} sol!`, {
        reply_markup: {
          keyboard: [
            [{ text: "➕ Add New Token" }],
            [{ text: "💰 Buy Token" }, { text: "💸 Sell Token" }],
            [{ text: "📊 Check Balance" }],
          ],
          resize_keyboard: true,
        },
      });
    } catch (error: any) {
      return bot.sendMessage(userId, `❌ Error: ${error.message}`);
    }
  }
}); // Buy handler
bot.onText(/💰 Buy Token/, (msg) => {
  const userId = msg.from!.id;
  users[userId].step = "awaiting_buy";
  return bot.sendMessage(userId, "Enter the amount of SOL to swap:", {
    reply_markup: {
      keyboard: [
        [{ text: "➕ Add New Token" }],
        [{ text: "💰 Buy Token" }, { text: "💸 Sell Token" }],
        [{ text: "📊 Check Balance" }],
      ],
      remove_keyboard: true,
    },
  });
});

bot.onText(/📊 Check Balance/, async (msg) => {
  const userId = msg.from!.id;
  const user = users[userId];
  console.log(user);
  const token_balance = await getTokenBalance(
    wallet.publicKey,
    new PublicKey(user.token!)
  );
  const sol_balance = await connection.getBalance(wallet.publicKey);
  user.step = "idle";
  return bot.sendMessage(
    userId,
    `Sol balance: ${sol_balance}, token balance: ${token_balance}`,
    {
      reply_markup: {
        keyboard: [
          [{ text: "➕ Add New Token" }],
          [{ text: "💰 Buy Token" }, { text: "💸 Sell Token" }],
          [{ text: "📊 Check Balance" }],
        ],
        remove_keyboard: true,
      },
    }
  );
});

// Sell handler
bot.onText(/💸 Sell Token/, async (msg) => {
  const userId = msg.from!.id;
  if (!users[userId]) {
    users[userId] = { sol_balance: 0, token_balance: 0, step: "idle" }; // Ensure user is initialized
  }
  const user = users[userId];
  const token_balance = await getTokenBalance(
    wallet.publicKey,
    new PublicKey(user.token!)
  );
  const sol_balance = await connection.getBalance(wallet.publicKey);
  user.token_balance = token_balance;
  user.sol_balance = sol_balance;

  if (!user || user.token_balance <= 0) {
    return bot.sendMessage(userId, "❌ You don't have any tokens to sell.");
  }

  return bot.sendMessage(userId, "Choose the percentage to sell:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "20%", callback_data: "sell_20" },
          { text: "50%", callback_data: "sell_50" },
        ],
        [
          { text: "70%", callback_data: "sell_70" },
          { text: "100%", callback_data: "sell_100" },
        ],
      ],
    },
  });
});

bot.onText(/➕ Add New Token/, (msg) => {
  const userId = msg.from!.id;
  if (!users[userId]) {
    users[userId] = { sol_balance: 0, token_balance: 0, step: "idle" }; // Ensure user is initialized
  }
  const user = users[userId];
  user.step = "awaiting_wallet";
  bot.sendMessage(userId, "Welcome! Set token address:");
});

// Handle Sell Callback Queries
bot.on("callback_query", async (query) => {
  const userId = query.from!.id;
  const user = users[userId];
  const callbackData = query.data;

  if (!callbackData) {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ Invalid callback data.",
    });
  }

  if (!user || user.token_balance <= 0) {
    return bot.answerCallbackQuery(query.id, {
      text: "❌ No tokens available to sell.",
    });
  }

  let percentageToSell = 0;

  switch (callbackData) {
    case "sell_20":
      percentageToSell = 20;
      break;
    case "sell_50":
      percentageToSell = 50;
      break;
    case "sell_70":
      percentageToSell = 70;
      break;
    case "sell_100":
      percentageToSell = 100;
      break;
    default:
      return bot.answerCallbackQuery(query.id, { text: "❌ Invalid option." });
  }

  const amountToSell = Math.floor(
    (Number(user.token_balance) * Number(percentageToSell)) / Number(100)
  );

  try {
    // Call your sellCrypto function here
    await sellCrypto(user.token!, amountToSell);
    user.token_balance = await getTokenBalance(
      wallet.publicKey,
      new PublicKey(user.token!)
    );
    user.sol_balance = await connection.getBalance(wallet.publicKey);
    bot.answerCallbackQuery(query.id, {
      text: `✅ Sold ${percentageToSell}% (${amountToSell} tokens)`,
    });
    return bot.editMessageText(
      `✅ Successfully sold ${percentageToSell}% of your tokens!\nNew balance: ${user.token_balance}`,
      { chat_id: query.message!.chat.id, message_id: query.message!.message_id }
    );
  } catch (error: unknown) {
    return bot.answerCallbackQuery(query.id, {
      text: `❌ Error: ${
        error instanceof Error ? error.message : "Unknown error occurred"
      }`,
    });
  }
}); // Dummy functions for buy and sell (replace with actual logic)
async function buyCrypto(token: string, amount: number) {
  const quoteResponse = (
    await axios.get(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${token}&amount=${amount}&slippageBps=9000`
    )
  ).data;

  const swapResponse = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
    quoteResponse,
    userPublicKey: wallet.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 1000000,
        priorityLevel: "high",
      },
    },
  });

  const transactionBase64 = swapResponse.data.swapTransaction;

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(transactionBase64, "base64")
  );

  transaction.sign([wallet]);
  const transactionBinary = transaction.serialize();

  const signature = await connection.sendRawTransaction(transactionBinary, {});
  //   await connection.confirmTransaction(signature, "finalized");
}

async function sellCrypto(token: string, amount: number) {
  const quoteResponse = (
    await axios.get(
      `https://quote-api.jup.ag/v6/quote?inputMint=${token}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=9000`
    )
  ).data;

  const swapResponse = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
    quoteResponse,
    userPublicKey: wallet.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 1000000,
        priorityLevel: "high",
      },
    },
  });

  const transactionBase64 = swapResponse.data.swapTransaction;

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(transactionBase64, "base64")
  );

  transaction.sign([wallet]);
  const transactionBinary = transaction.serialize();

  const signature = await connection.sendRawTransaction(transactionBinary, {
    skipPreflight: true,
  });
  //   await connection.confirmTransaction(signature, "finalized");
}

async function getTokenBalance(wallet: PublicKey, mint: PublicKey) {
  const ata = await getAssociatedTokenAddress(mint, wallet);
  try {
    const account = await getAccount(connection, ata);
    return Number(account.amount); // Token balance
  } catch (e) {
    return 0; // If the account doesn't exist, balance is 0
  }
}
