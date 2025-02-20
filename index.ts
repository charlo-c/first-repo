import { VersionedTransaction, Keypair, SystemProgram, Transaction, Connection, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, AddressLookupTableProgram, PublicKey, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction } from "@solana/web3.js"
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { AnchorProvider } from "@coral-xyz/anchor";
import { openAsBlob } from "fs";
import base58 from "bs58"

import { DESCRIPTION, DISTRIBUTION_WALLETNUM, FILE, global_mint, JITO_FEE, PRIVATE_KEY, PUMP_PROGRAM, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, SWAP_AMOUNT, TELEGRAM, TOKEN_CREATE_ON, TOKEN_NAME, TOKEN_SHOW_NAME, TOKEN_SYMBOL, TWITTER, WEBSITE } from "./constants"
import { readJson, saveDataToFile, sleep } from "./utils"
import { createAndSendV0Tx, execute } from "./executor/legacy"
import { PumpFunSDK } from "./src/pumpfun";
import { executeJitoTx } from "./executor/jito";
import { displayStatus } from "./status"

const commitment = "confirmed"

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment
})
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))

let kps: Keypair[] = []
const transactions: VersionedTransaction[] = []
const mintKp = Keypair.generate()

// const mintKp = Keypair.fromSecretKey(base58.decode("LHkkEvTRv4k8f5c8x8GZPuRieQLSVWZj7t6FvWs5mFwaVCmTjkNTf7a6yELGR1E5mB1fZkBm9XVeoZi2vAQP1bG"))
// const mintAddress = new PublicKey("ATyeiG6GGXQjHzG3MuNTTMRaZiDTSCxpSjNuAbaUpump")

const mintAddress = mintKp.publicKey

let sdk = new PumpFunSDK(new AnchorProvider(connection, new NodeWallet(new Keypair()), { commitment }));

const main = async () => {

  console.log(await connection.getBalance(mainKp.publicKey) / 10 ** 9, "SOL in main keypair")

  saveDataToFile([base58.encode(mintKp.secretKey)], "mint.json")

  const tokenCreationIxs = await createTokenTx()

  console.log("Distributing SOL to wallets...")
  await distributeSol(connection, mainKp, DISTRIBUTION_WALLETNUM)
  //               |||||||||||||||||||
  // kps = readJson().map(kpStr => Keypair.fromSecretKey(base58.decode(kpStr)))
  // kps.map(async (kp) => console.log(await connection.getBalance(kp.publicKey) / 10 ** 9))
  console.log("Creating LUT started")

  // const lutAddress = new PublicKey("3kiaETbSPK62v2nm8Bg1no6WrupTMjpiRxNDGMsuqEBy")
  //      |||||||||||||||||
  const lutAddress = await createLUT()

  saveDataToFile([], "mint.json")
  if (!lutAddress) {
    console.log("Lut creation failed")
    return
  }
  console.log("LUT Address:", lutAddress.toBase58())
  await addAddressesToTable(lutAddress, mintAddress, kps)

  const buyIxs: TransactionInstruction[] = []

  for (let i = 0; i < DISTRIBUTION_WALLETNUM; i++) {
    const ix = await makeBuyIx(kps[i], Math.floor(SWAP_AMOUNT * 10 ** 9))
    buyIxs.push(...ix)
  }

  const lookupTable = (await connection.getAddressLookupTable(lutAddress)).value;
  if (!lookupTable) {
    console.log("Lookup table not ready")
    return
  }
  const latestBlockhash = await connection.getLatestBlockhash()

  const tokenCreationTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: tokenCreationIxs
    }).compileToV0Message()
  )

  tokenCreationTx.sign([mainKp, mintKp])

  transactions.push(tokenCreationTx)
  for (let i = 0; i < Math.ceil(DISTRIBUTION_WALLETNUM / 5); i++) {
    const latestBlockhash = await connection.getLatestBlockhash()
    const instructions: TransactionInstruction[] = []

    for (let j = 0; j < 5; j++) {
      const index = i * 5 + j
      if (kps[index])
        instructions.push(buyIxs[index * 2], buyIxs[index * 2 + 1])
    }
    const msg = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message([lookupTable])

    const tx = new VersionedTransaction(msg)
    tx.sign([mainKp])
    for (let j = 0; j < 5; j++) {
      const index = i * 5 + j
      if (kps[index])
        tx.sign([kps[index]])
    }
    transactions.push(tx)
  }

  // transactions.map(async (tx, i) => console.log(i, " | ", tx.serialize().length, "bytes | \n", (await connection.simulateTransaction(tx, { sigVerify: true }))))
  await executeJitoTx(transactions, mainKp, commitment)

  await sleep(10000)
  console.log("Displaying status of wallets that bought token")
  displayStatus()
}


const distributeSol = async (connection: Connection, mainKp: Keypair, distritbutionNum: number) => {
  try {
    const sendSolTx: TransactionInstruction[] = []
    sendSolTx.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 })
    )
    const mainSolBal = await connection.getBalance(mainKp.publicKey)
    if (mainSolBal <= 4 * 10 ** 6) {
      console.log("Main wallet balance is not enough")
      return []
    }
    let solAmount = Math.floor((SWAP_AMOUNT + 0.005) * 10 ** 9)

    for (let i = 0; i < distritbutionNum; i++) {

      const wallet = Keypair.generate()
      kps.push(wallet)

      sendSolTx.push(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: solAmount
        })
      )
    }

    try {
      saveDataToFile(kps.map(kp => base58.encode(kp.secretKey)))
    } catch (error) {

    }

    let index = 0
    while (true) {
      try {
        if (index > 5) {
          console.log("Error in distribution")
          return null
        }
        const siTx = new Transaction().add(...sendSolTx)
        const latestBlockhash = await connection.getLatestBlockhash()
        siTx.feePayer = mainKp.publicKey
        siTx.recentBlockhash = latestBlockhash.blockhash
        const messageV0 = new TransactionMessage({
          payerKey: mainKp.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: sendSolTx,
        }).compileToV0Message()
        const transaction = new VersionedTransaction(messageV0)
        transaction.sign([mainKp])
        // console.log(await connection.simulateTransaction(transaction))
        let txSig = await execute(transaction, latestBlockhash, 1)

        if (txSig) {
          const distibuteTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
          console.log("SOL distributed ", distibuteTx)
          break
        }
        index++
      } catch (error) {
        index++
      }
    }

    console.log("Success in distribution")
    return kps
  } catch (error) {
    console.log(`Failed to transfer SOL`, error)
    return null
  }
}

// create token instructions
const createTokenTx = async () => {
  const tokenInfo = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    description: DESCRIPTION,
    showName: TOKEN_SHOW_NAME,
    createOn: TOKEN_CREATE_ON,
    twitter: TWITTER,
    telegram: TELEGRAM,
    website: WEBSITE,
    file: await openAsBlob(FILE),
  };
  let tokenMetadata = await sdk.createTokenMetadata(tokenInfo);

  let createIx = await sdk.getCreateInstructions(
    mainKp.publicKey,
    tokenInfo.name,
    tokenInfo.symbol,
    tokenMetadata.metadataUri,
    mintKp
  );

  const tipAccounts = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];
  const jitoFeeWallet = new PublicKey(tipAccounts[Math.floor(tipAccounts.length * Math.random())])
  return [
    SystemProgram.transfer({
      fromPubkey: mainKp.publicKey,
      toPubkey: jitoFeeWallet,
      lamports: Math.floor(JITO_FEE * 10 ** 9),
    }),
    createIx
  ]
}

// make buy instructions
const makeBuyIx = async (kp: Keypair, buyAmount: number) => {
  let buyIx = await sdk.getBuyInstructionsBySolAmount(
    kp.publicKey,
    mintAddress,
    BigInt(buyAmount),
    BigInt(1000),
    commitment
  );

  return buyIx

}

const createLUT = async () => {
  let i = 0
  while (true) {
    if (i > 5) {
      console.log("LUT creation failed, Exiting...")
      return
    }
    try {
      const [lookupTableInst, lookupTableAddress] =
        AddressLookupTableProgram.createLookupTable({
          authority: mainKp.publicKey,
          payer: mainKp.publicKey,
          recentSlot: await connection.getSlot(),
        });

      // Step 2 - Log Lookup Table Address
      console.log("Lookup Table Address:", lookupTableAddress.toBase58());

      // Step 3 - Generate a create transaction and send it to the network
      const result = await createAndSendV0Tx([lookupTableInst], mainKp, connection);

      if (!result)
        throw new Error("Lut creation error")

      console.log("Lookup Table Address created successfully!")
      console.log("Please wait for about 15 seconds...")
      await sleep(10000)

      return lookupTableAddress
    } catch (err) {
      console.log("Error in creating Lookuptable. Retrying.")
      i++
    }
  }
}

async function addAddressesToTable(lutAddress: PublicKey, mint: PublicKey, walletKPs: Keypair[]) {

  const walletPKs: PublicKey[] = walletKPs.map(wallet => wallet.publicKey);

  try {
    let i = 0
    while (true) {
      if (i > 5) {
        console.log("Extending LUT failed, Exiting...")
        return
      }

      // Step 1 - Adding bundler wallets
      const addAddressesInstruction = AddressLookupTableProgram.extendLookupTable({
        payer: mainKp.publicKey,
        authority: mainKp.publicKey,
        lookupTable: lutAddress,
        addresses: walletPKs,
      });
      const result = await createAndSendV0Tx([addAddressesInstruction], mainKp, connection);
      if (result) {
        console.log("Successfully added wallet addresses.")
        i = 0
        break
      } else {
        console.log("Trying again with step 1")
      }
    }
    await sleep(3000)

    // Step 2 - Adding wallets' token ata
    while (true) {
      if (i > 5) {
        console.log("Extending LUT failed, Exiting...")
        return
      }

      console.log(`Adding atas for the token ${mint.toBase58()}`)
      const baseAtas: PublicKey[] = []

      for (const wallet of walletKPs) {
        const baseAta = getAssociatedTokenAddressSync(mint, wallet.publicKey)
        baseAtas.push(baseAta);
      }
      console.log("Base atas address num to extend: ", baseAtas.length)
      const addAddressesInstruction1 = AddressLookupTableProgram.extendLookupTable({
        payer: mainKp.publicKey,
        authority: mainKp.publicKey,
        lookupTable: lutAddress,
        addresses: baseAtas,
      });
      const result = await createAndSendV0Tx([addAddressesInstruction1], mainKp, connection);

      if (result) {
        console.log("Successfully added base ata addresses.")
        i = 0
        break
      } else {
        console.log("Trying again with step 2")
      }
    }
    await sleep(3000)

    // Step 3 - Adding wallets' wsol ata
    // while (true) {
    //   if (i > 5) {
    //     console.log("Extending LUT failed, Exiting...")
    //     return
    //   }
    //   const quoteAtas: PublicKey[] = []
    //   for (const wallet of walletKPs) {
    //     const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey)
    //     quoteAtas.push(quoteAta);
    //   }
    //   const addAddressesInstruction2 = AddressLookupTableProgram.extendLookupTable({
    //     payer: mainKp.publicKey,
    //     authority: mainKp.publicKey,
    //     lookupTable: lutAddress,
    //     addresses: quoteAtas,
    //   });
    //   const result = await createAndSendV0Tx([addAddressesInstruction2], mainKp, connection);

    //   if (result) {
    //     console.log("Successfully added WSOL ata addresses.")
    //     i = 0
    //     break
    //   } else {
    //     console.log("Trying again with step 3")
    //   }
    // }
    // await sleep(3000)

    // Step 4 - Adding main wallet and static keys

    while (true) {
      if (i > 5) {
        console.log("Extending LUT failed, Exiting...")
        return
      }
      const addAddressesInstruction3 = AddressLookupTableProgram.extendLookupTable({
        payer: mainKp.publicKey,
        authority: mainKp.publicKey,
        lookupTable: lutAddress,
        addresses: [mainKp.publicKey, global_mint, mint, PUMP_PROGRAM, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY, NATIVE_MINT],
      });

      const result = await createAndSendV0Tx([addAddressesInstruction3], mainKp, connection);

      if (result) {
        console.log("Successfully added main wallet address.")
        i = 0
        break
      } else {
        console.log("Trying again with step 4")
      }
    }
    await sleep(5000)

    console.log("Lookup Table Address extended successfully!")
    console.log(`Lookup Table Entries: `, `https://explorer.solana.com/address/${lutAddress.toString()}/entries`)
  }
  catch (err) {
    console.log("There is an error in adding addresses in LUT. Please retry it.")
    return;
  }
}


main()

