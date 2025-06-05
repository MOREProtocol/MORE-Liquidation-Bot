const _ = require("lodash");
const { Telegraf } = require('telegraf');
const { HttpLink } = require("apollo-link-http");
const { ApolloClient } = require("apollo-client");
const { InMemoryCache } = require("apollo-cache-inmemory");
const {
  utils,
  constants,
  providers,
  BigNumber,
  Wallet,
  Contract,
} = require("ethers");

const { usersQuery } = require("./query.js");

const config = require("./config.json");
const PoolAbi = require("./abis/Pool.json");
const MTokenAbi = require("./abis/MToken.json");
const MulticallAbi = require("./abis/MulticallAbi.json");
const LiquidationAbi = require("./abis/Liquidation.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);

// interfaces
const poolInterface = new utils.Interface(PoolAbi);
const mTokenInterface = new utils.Interface(MTokenAbi);

const multicallContract = new Contract(
  config.contracts.multicall,
  MulticallAbi,
  provider
);

const apolloFetcher = async (query) => {
  const client = new ApolloClient({
    link: new HttpLink({
      uri: config.subgraph_url,
    }),
    cache: new InMemoryCache(),
  });

  return client.query({
    query: query.query,
    variables: query.variables,
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. fetch users with AccountData
  let allUsers = [];
  let skip = 0;
  const first = 100;
  let fetchNext = true;

  // Fetch users in batches of 100 until all are retrieved from the subgraph
  while (fetchNext) {
    const query = {
      query: usersQuery,
      variables: { first, skip },
    };
    const accountsInfo = await apolloFetcher(query);
    const fetchedUsers = accountsInfo?.data?.users || [];
    allUsers = allUsers.concat(fetchedUsers);

    if (fetchedUsers.length < first) {
      fetchNext = false;
    } else {
      skip += first;
    }
    console.log(`Fetched ${fetchedUsers.length} users, total: ${allUsers.length}`);
  }
  const users = allUsers;

  let usersHealthReq = [];
  const userChunkSize = 50;
  let allUsersHealthRes = []

  // For each chunk of users, fetch their health data for all pools using multicall (batch on-chain calls)
  for (let poolInd = 0; poolInd < config.pools.length; poolInd++) {
    const pool = config.pools[poolInd];
    for (let i = 0; i < users.length; i += userChunkSize) {
      const userChunk = users.slice(i, i + userChunkSize);
      usersHealthReq = []; // Reset for each chunk

      userChunk.map((user) => {
        usersHealthReq.push({
          target: pool,
          callData: poolInterface.encodeFunctionData("getUserAccountData", [
            user.id,
          ]),
        });
      });

      if (usersHealthReq.length > 0) {
        const chunkHealthRes = await multicallContract.callStatic.aggregate(
          usersHealthReq
        );

        const userWithHealth = chunkHealthRes.returnData.map((userHealth, ind) => {
          const detailedInfo = poolInterface.decodeFunctionResult(
            "getUserAccountData",
            userHealth
          );
          const userId = users[ind + i].id
          return {
            pool: pool,
            user: userId,
            healthFactor: BigNumber.from(detailedInfo.healthFactor),
          }
        });

        allUsersHealthRes = allUsersHealthRes.concat(userWithHealth);
        console.log(`Pool ${config.pools[poolInd]}: processed batch of ${userChunk.length} users for health checks.`);
      }
    }
  }

  // Filter users whose health factor is below 1 (unhealthy, eligible for liquidation)
  const unhealthyUsers = allUsersHealthRes.filter(
    (userHealth) =>
      userHealth.healthFactor.lte(constants.WeiPerEther) && userHealth.healthFactor.gt(0)
  );
  // Filter users whose health factor is below 1.05 (for info)
  const wideUnhealthyUsers = allUsersHealthRes.filter(
    (userHealth) =>
      userHealth.healthFactor.lt(constants.WeiPerEther.mul(105).div(100)) && userHealth.healthFactor.gte(constants.WeiPerEther)
  ).sort((a, b) => {
    // Sort by ascending health factor
    if (a.healthFactor.lt(b.healthFactor)) return -1;
    if (a.healthFactor.gt(b.healthFactor)) return 1;
    return 0;
  });
  // Filter users whose health factor is 0 (for info)
  const zeroHealthUsers = allUsersHealthRes.filter(
    (userHealth) =>
      userHealth.healthFactor.eq(0)
  );

  // Only send Telegram notification every day at 12:00 UTC if there are at-risk users
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  if (currentHour === 12 && currentMinute === 0) {
    if (wideUnhealthyUsers.length > 0) {
      try {
        const bot = new Telegraf(config.bot_token);
        await bot.telegram.sendMessage(
          config.info_chat_id, `Unhealthy users: ${wideUnhealthyUsers.map(u => `${u.user} (${(u.healthFactor.toString() / 1e18).toFixed(2)})`).join(', ')}`);
      } catch (err) {
        console.error("Error sending message:", err);
      }
    }
    if (zeroHealthUsers.length > 0) {
      try {
        const bot = new Telegraf(config.bot_token);
        await bot.telegram.sendMessage(
          config.info_chat_id, `Zero HF users: ${zeroHealthUsers.map(u => `${u.user}`).join(', ')}`);
      } catch (err) {
        console.error("Error sending message:", err);
      }
    }
  }

  // For debugging
  // console.log('unhealthyUsers', unhealthyUsers);
  // console.log('wideUnhealthyUsers', wideUnhealthyUsers);
  // console.log('zeroHealthUsers', zeroHealthUsers);

  // 3. Fetch unhealthy users debt info and attempt liquidation
  const liquidator = new Wallet(config.liquidator_key, provider);
  for (const unhealthyUser of unhealthyUsers) {
    try {
      const bot = new Telegraf(config.bot_token);
      await bot.telegram.sendMessage(
        config.alert_chat_id, `Starting liquidation for user ${unhealthyUser.user}. HF: ${(unhealthyUser.healthFactor.toString() / 1e18).toFixed(2)}`);
    } catch (err) {
      console.error("Error sending message:", err);
    }

    let collateralAsset = "";
    let debtAsset = "";

    const botInfo = config.bots[unhealthyUser.pool];
    let mTokenRequest = [];
    // Prepare multicall requests for all mTokens and dTokens (to get balances and underlying assets)
    botInfo.mTokens.map((mToken) => {
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [
          unhealthyUser.user,
        ]),
      });

      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData(
          "UNDERLYING_ASSET_ADDRESS",
          []
        ),
      });
    });

    botInfo.dTokens.map((dToken) => {
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [
          unhealthyUser.user,
        ]),
      });

      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData(
          "UNDERLYING_ASSET_ADDRESS",
          []
        ),
      });
    });
    const tokenRes = await multicallContract.callStatic.aggregate(
      mTokenRequest
    );

    let mInfos = [];
    let dInfos = [];
    let tokensWithUnderlying = [];
    // Parse multicall results to get balances and underlying asset addresses
    const tokenInfos = tokenRes[1].map((tokenRes, ind) => ({
      info: mTokenInterface.decodeFunctionResult(
        ind % 2 == 0 ? "balanceOf" : "UNDERLYING_ASSET_ADDRESS",
        tokenRes
      ),
    }));
    for (let ii = 0; ii < tokenInfos.length; ii++) {
      const selInd = ii % 2;
      if (selInd == 0) {
        const detailedInfo = tokenInfos[ii].info[0];
        if (detailedInfo.gt(0)) {
          if (ii < botInfo.mTokens.length * 2) {
            mInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          } else {
            dInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          }
        }
      } else if (ii < botInfo.mTokens.length * 2) {
        // prepare array of underlying:mToken pairs
        const detailedInfo = tokenInfos[ii].info[0].toLowerCase();
        const selInd = tokensWithUnderlying.findIndex(
          (tokenItem) => tokenItem.token == detailedInfo
        );
        if (selInd < 0) {
          tokensWithUnderlying.push({
            token: detailedInfo,
            mtoken: botInfo.mTokens[Math.floor(ii / 2)],
          });
        }
      }
    }

    // If user has both collateral and debt, proceed to liquidation
    if (mInfos.length > 0 && dInfos.length > 0) {
      collateralAsset = mInfos[0].token[0];
      debtAsset = dInfos[0].token[0];

      const debtContract = new Contract(debtAsset, MTokenAbi, provider);
      // Find the mToken contract for the debt asset
      const debtMToken = tokensWithUnderlying.find(
        (uToken) => uToken.token == debtAsset.toLowerCase()
      );
      if (debtMToken) {
        // Get how much debtToken is available in the mToken contract
        const debtBalanceInmToken = await debtContract.balanceOf(
          debtMToken.mtoken
        );
        const increasedDebtBal = dInfos[0].amount
        // If user's debt is more than available, cap it to available
        const checkedBal = increasedDebtBal.gt(debtBalanceInmToken)
          ? debtBalanceInmToken
          : increasedDebtBal;
        const cover = increasedDebtBal.gt(debtBalanceInmToken)
          ? debtBalanceInmToken
          : constants.MaxUint256;

        // Prepare liquidation parameters and call the liquidation contract
        const botContract = new Contract(
          config.bots[unhealthyUser.pool].bot,
          LiquidationAbi,
          provider
        );
        const lParam = {
          collateralAsset,
          debtAsset,
          user: unhealthyUser.user,
          amount: checkedBal,
          transferAmount: 0,
          debtToCover: cover,
        };
        const sParam = {
          receiver: liquidator.address,
          routerV2: config.contracts.punch.router,
          routerV3: config.contracts.trado.router,
          quoter: config.contracts.trado.quoter,
          path1: [collateralAsset, debtAsset],
          path2: [debtAsset, config.contracts.wflow],
        };

        console.log(lParam, sParam);
        try {
          const tx = await botContract
            .connect(liquidator)
            .execute(lParam, sParam);
          const txReceipt = await tx.wait();
          console.log('txReceipt', txReceipt);
          try {
            const bot = new Telegraf(config.bot_token);
            await bot.telegram.sendMessage(
              config.alert_chat_id, `Liquidation for user ${unhealthyUser.user} completed. TxId: ${txReceipt.transactionHash}`);
          } catch (err) {
            console.error("Error sending message:", err);
          }
        } catch (err) {
          const revertReason = err?.error?.reason || err?.reason || err?.data || err.message;
          console.error("Transaction reverted:", revertReason);
          try {
            const bot = new Telegraf(config.bot_token);
            await bot.telegram.sendMessage(
              config.alert_chat_id, `Liquidation for user ${unhealthyUser.user} failed. Reason: ${revertReason.slice(0, 100)}`);
          } catch (err) {
            console.error("Error sending message:", err);
          }
        }

        await sleep(5000);
      } else {
        console.log(debtAsset, collateralAsset, tokensWithUnderlying);
        console.log("unexpected");
      }
    } else {
      console.log('No collateral or debt for user', unhealthyUser.user);
      console.log('mInfos', mInfos);
      console.log('dInfos', dInfos);
      try {
        const bot = new Telegraf(config.bot_token);
        await bot.telegram.sendMessage(
          config.alert_chat_id, `No collateral or debt for user ${unhealthyUser.user}. HF: ${(unhealthyUser.healthFactor.toString() / 1e18).toFixed(2)}`);
      } catch (err) {
        console.error("Error sending message:", err);
      }
    }
  }
}

// Handler for AWS Lambda. Comment out to run locally.
exports.handler = async (event) => {
  console.log("Event received:", event);
  try {
    await main()
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "OK" }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error" }),
    };
  }
};

// main()