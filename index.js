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
const { RouterQuoteManager } = require("./router-quotes.js");

const config = require("./config.json");
const PoolAbi = require("./abis/Pool.json");
const MTokenAbi = require("./abis/MToken.json");
const MulticallAbi = require("./abis/MulticallAbi.json");
const LiquidationAbi = require("./abis/Liquidation.json");
const AddressesProviderAbi = require("./abis/AddressesProviderAbi.json");
const PriceOracleAbi = require("./abis/PriceOracleAbi.json");
const ERC20Abi = require("./abis/ERC20Abi.json");

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

// Recursive function to convert hex values to decimals for better readability
function formatHexToDecimal(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle BigNumber objects
  if (obj && typeof obj === 'object' && obj._hex) {
    return obj.toString();
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => formatHexToDecimal(item));
  }

  // Handle objects
  if (typeof obj === 'object') {
    const formatted = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip formatting the "path" key as it contains addresses
      if (key === 'path') {
        formatted[key] = value;
      } else {
        formatted[key] = formatHexToDecimal(value);
      }
    }
    return formatted;
  }

  // Handle hex strings that look like numbers (0x...)
  if (typeof obj === 'string' && obj.startsWith('0x') && obj.length > 2) {
    try {
      const decimal = BigNumber.from(obj).toString();
      // Only convert if it's actually a number (not an address)
      if (obj.length > 42) { // Addresses are 42 chars, longer hex strings are likely numbers
        return decimal;
      }
    } catch (e) {
      // If conversion fails, return original
    }
  }

  return obj;
}

// Helper function to decode reserve configuration data to extract liquidation bonus
function extractLiquidationBonus(configurationData) {
  // Aave configuration data is packed into a single uint256
  // Liquidation bonus is stored in bits 32-47 (16 bits)
  const data = BigNumber.from(configurationData);
  const liquidationBonus = data.shr(32).and(0xFFFF); // Extract bits 32-47
  return liquidationBonus;
}

// Helper function to get the price oracle address from the pool
async function getPriceOracleAddress(poolAddress) {
  try {
    const poolContract = new Contract(poolAddress, PoolAbi, provider);
    const addressesProviderAddress = await poolContract.ADDRESSES_PROVIDER();
    const addressesProviderContract = new Contract(addressesProviderAddress, AddressesProviderAbi, provider);
    const priceOracleAddress = await addressesProviderContract.getPriceOracle();
    return priceOracleAddress;
  } catch (error) {
    console.error(`Error fetching price oracle address from pool ${poolAddress}:`, error);
    return null;
  }
}

// Helper function to get asset price from the pool's price oracle
async function getAssetPrice(assetAddress, poolAddress) {
  try {
    const priceOracleAddress = await getPriceOracleAddress(poolAddress);
    if (!priceOracleAddress) {
      throw new Error("Could not get price oracle address");
    }

    const priceOracleContract = new Contract(priceOracleAddress, PriceOracleAbi, provider);
    const price = await priceOracleContract.getAssetPrice(assetAddress);
    return price;
  } catch (error) {
    console.error(`Error fetching price for asset ${assetAddress}:`, error);
    return BigNumber.from(0);
  }
}

// Helper function to get token decimals
async function getTokenDecimals(tokenAddress) {
  try {
    const tokenContract = new Contract(tokenAddress, ERC20Abi, provider);
    const decimals = await tokenContract.decimals();
    return decimals;
  } catch (error) {
    console.error(`Error fetching decimals for token ${tokenAddress}:`, error);
    return 18; // Default to 18 decimals
  }
}

// Helper function to check if asset can be used as collateral
function extractUsageAsCollateralEnabled(configurationData) {
  // usageAsCollateralEnabled is stored in bit 56 (1 bit)
  const data = BigNumber.from(configurationData);
  const usageAsCollateralEnabled = data.shr(56).and(0x1); // Extract bit 56
  return usageAsCollateralEnabled.eq(1);
}

// Helper function to get reserve configuration data (liquidation bonus + collateral enabled)
async function getReserveConfiguration(poolAddress, assetAddress) {
  try {
    const poolContract = new Contract(poolAddress, PoolAbi, provider);
    const reserveData = await poolContract.getReserveData(assetAddress);
    const liquidationBonus = extractLiquidationBonus(reserveData.configuration.data);
    const usageAsCollateralEnabled = extractUsageAsCollateralEnabled(reserveData.configuration.data);
    return {
      liquidationBonus,
      usageAsCollateralEnabled
    };
  } catch (error) {
    console.error(`Error fetching reserve configuration for asset ${assetAddress}:`, error);
    return {
      liquidationBonus: BigNumber.from(0),
      usageAsCollateralEnabled: false
    };
  }
}

// Helper function to get liquidation bonus for an asset from the pool
async function getLiquidationBonus(poolAddress, assetAddress) {
  const config = await getReserveConfiguration(poolAddress, assetAddress);
  return config.liquidationBonus;
}

// Aave V3 liquidation constants (based on Aave documentation)
const CLOSE_FACTOR_HF_THRESHOLD = utils.parseEther('0.95'); // 0.95e18
const DEFAULT_LIQUIDATION_CLOSE_FACTOR = 5000; // 50% in basis points
const MAX_LIQUIDATION_CLOSE_FACTOR = 10000; // 100% in basis points

// Helper function to calculate debt to cover based on close factor and health factor
function calculateDebtToCover(healthFactor, userDebtBalance) {
  let closeFactor;

  if (healthFactor.lt(CLOSE_FACTOR_HF_THRESHOLD)) {
    // Health factor < 0.95: can liquidate up to 100% of debt
    closeFactor = MAX_LIQUIDATION_CLOSE_FACTOR;
    console.log(`Health factor ${utils.formatEther(healthFactor)} < 0.95: Using MAX close factor (100%)`);
  } else {
    // Health factor >= 0.95 but < 1: can liquidate up to 50% of debt
    closeFactor = DEFAULT_LIQUIDATION_CLOSE_FACTOR;
    console.log(`Health factor ${utils.formatEther(healthFactor)} >= 0.95: Using DEFAULT close factor (50%)`);
  }

  // Calculate maximum debt that can be covered
  const maxDebtToCover = userDebtBalance.mul(closeFactor).div(10000);

  console.log(`Close factor: ${closeFactor / 100}%`);
  console.log(`User debt balance: ${userDebtBalance.toString()}`);
  console.log(`Max debt to cover: ${maxDebtToCover.toString()}`);

  return maxDebtToCover;
}

// Helper function to select the best collateral asset for liquidation
async function selectBestCollateralAsset(poolAddress, mInfos) {
  console.log('Evaluating collateral assets for liquidation...');

  const collateralCandidates = [];
  const oracleDecimals = 8; // Assuming 8 decimals for oracle prices

  for (const mInfo of mInfos) {
    const assetAddress = mInfo.token[0];
    const assetBalance = mInfo.amount;

    try {
      // Get reserve configuration
      const reserveConfig = await getReserveConfiguration(poolAddress, assetAddress);

      // Skip if asset cannot be used as collateral
      if (!reserveConfig.usageAsCollateralEnabled) {
        console.log(`Asset ${assetAddress} cannot be used as collateral (usageAsCollateralEnabled = false)`);
        continue;
      }

      // Get asset price and decimals
      const [assetPrice, assetDecimals] = await Promise.all([
        getAssetPrice(assetAddress, poolAddress),
        getTokenDecimals(assetAddress)
      ]);

      // Calculate USD value of the asset balance
      const assetValueUSD = assetPrice
        .mul(assetBalance)
        .div(BigNumber.from(10).pow(assetDecimals)) // Convert to token units
        .div(BigNumber.from(10).pow(oracleDecimals)); // Convert price to USD

      const assetValueUSDFormatted = utils.formatUnits(
        assetPrice.mul(assetBalance).div(BigNumber.from(10).pow(assetDecimals)),
        oracleDecimals
      );

      console.log(`Asset ${assetAddress}:`);
      console.log(`  - Price: $${utils.formatUnits(assetPrice, oracleDecimals)}`);
      console.log(`  - Balance: ${utils.formatUnits(assetBalance, assetDecimals)}`);
      console.log(`  - USD Value: $${assetValueUSDFormatted}`);
      console.log(`  - Liquidation Bonus: ${reserveConfig.liquidationBonus.toString()} basis points`);
      console.log(`  - Can be used as collateral: ${reserveConfig.usageAsCollateralEnabled}`);

      collateralCandidates.push({
        address: assetAddress,
        balance: assetBalance,
        price: assetPrice,
        decimals: assetDecimals,
        valueUSD: assetValueUSD,
        liquidationBonus: reserveConfig.liquidationBonus,
        usageAsCollateralEnabled: reserveConfig.usageAsCollateralEnabled
      });

    } catch (error) {
      console.error(`Error evaluating asset ${assetAddress}:`, error);
      continue;
    }
  }

  if (collateralCandidates.length === 0) {
    console.log('No suitable collateral assets found!');
    return null;
  }

  // Sort by USD value (descending) to get the most valuable collateral
  collateralCandidates.sort((a, b) => {
    if (a.valueUSD.gt(b.valueUSD)) return -1;
    if (a.valueUSD.lt(b.valueUSD)) return 1;
    return 0;
  });

  const bestCollateral = collateralCandidates[0];
  console.log(`Selected best collateral asset: ${bestCollateral.address}`);
  console.log(`  - USD Value: $${utils.formatUnits(bestCollateral.price.mul(bestCollateral.balance).div(BigNumber.from(10).pow(bestCollateral.decimals)), oracleDecimals)}`);
  console.log(`  - Liquidation Bonus: ${bestCollateral.liquidationBonus.toString()} basis points`);

  return bestCollateral;
}

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
            block: chunkHealthRes.blockNumber,
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
  // if (currentHour === 12 && currentMinute === 0) {
  //   if (wideUnhealthyUsers.length > 0) {
  //     try {
  //       const bot = new Telegraf(config.bot_token);
  //       await bot.telegram.sendMessage(
  //         config.info_chat_id, `Unhealthy users: ${wideUnhealthyUsers.map(u => `${u.user} (${(u.healthFactor.toString() / 1e18).toFixed(2)})`).join(', ')}`);
  //     } catch (err) {
  //       console.error("Error sending message:", err);
  //     }
  //   }
  //   if (zeroHealthUsers.length > 0) {
  //     try {
  //       const bot = new Telegraf(config.bot_token);
  //       await bot.telegram.sendMessage(
  //         config.info_chat_id, `Zero HF users: ${zeroHealthUsers.map(u => `${u.user}`).join(', ')}`);
  //     } catch (err) {
  //       console.error("Error sending message:", err);
  //     }
  //   }
  // }

  // For debugging
  console.log('unhealthyUsers', unhealthyUsers);
  console.log('wideUnhealthyUsers', wideUnhealthyUsers);
  console.log('zeroHealthUsers', zeroHealthUsers);

  // 3. Fetch unhealthy users debt info and attempt liquidation
  const liquidator = new Wallet(config.liquidator_key, provider);

  for (const unhealthyUser of unhealthyUsers) {
    // Get the bot contract address for this specific pool
    const botContractAddress = config.bots[unhealthyUser.pool].bot;
    const routerQuoteManager = new RouterQuoteManager(provider, config, liquidator.address, botContractAddress);
    // try {
    //   const bot = new Telegraf(config.bot_token);
    //   await bot.telegram.sendMessage(
    //     config.alert_chat_id, `Starting liquidation for user ${unhealthyUser.user}. HF: ${(unhealthyUser.healthFactor.toString() / 1e18).toFixed(2)}. Block: ${unhealthyUser.block.toString()}`);
    // } catch (err) {
    //   console.error("Error sending message:", err);
    // }

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
    // TODO: rank tokens by amount of USD value. get USSD price
    console.log('mInfos', mInfos);

    // If user has both collateral and debt, proceed to liquidation
    if (mInfos.length > 0 && dInfos.length > 0) {
      // Select the best collateral asset (highest value + usageAsCollateralEnabled)
      const bestCollateral = await selectBestCollateralAsset(unhealthyUser.pool, mInfos);

      if (!bestCollateral) {
        console.log('No suitable collateral assets found for user', unhealthyUser.user);
        continue;
      }

      collateralAsset = bestCollateral.address;
      debtAsset = dInfos[0].token[0]; // Still using first debt asset for now

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
        const userDebtBalance = dInfos[0].amount;
        const collateralBal = bestCollateral.balance;

        // https://aave.com/docs/developers/liquidations#executing-the-liquidation-call
        // Calculate debt to cover based on close factor and health factor
        const maxDebtToCoverByCloseFactor = calculateDebtToCover(unhealthyUser.healthFactor, userDebtBalance);

        // The actual debt to cover is limited by:
        // 1. Close factor limitation
        // 2. Available debt tokens in the mToken contract
        const checkedBal = BigNumber.min(
          maxDebtToCoverByCloseFactor,
          debtBalanceInmToken
        );

        // Set cover parameter: use calculated amount or let protocol handle max
        const cover = checkedBal.eq(maxDebtToCoverByCloseFactor)
          ? constants.MaxUint256  // Let protocol handle the close factor
          : checkedBal;           // Use our calculated limited amount

        console.log(`User debt balance: ${userDebtBalance.toString()}`);
        console.log(`Max debt by close factor: ${maxDebtToCoverByCloseFactor.toString()}`);
        console.log(`Available debt in mToken: ${debtBalanceInmToken.toString()}`);
        console.log(`Final debt to cover: ${checkedBal.toString()}`);

        // Prepare liquidation parameters and call the liquidation contract
        const botContract = new Contract(
          config.bots[unhealthyUser.pool].bot,
          LiquidationAbi,
          provider
        );

        // Get best quotes for both swaps using the router quote manager
        console.log(`Getting best swap routes for liquidation...`);
        console.log(`Collateral: ${collateralAsset}, Debt: ${debtAsset}, Amount: ${checkedBal.toString()}, Collateral Bal: ${collateralBal.toString()}`);

        // Use the data we already fetched from bestCollateral selection
        const liquidationBonus = bestCollateral.liquidationBonus;
        const collateralPrice = bestCollateral.price;
        const collateralDecimals = bestCollateral.decimals;

        console.log("Liquidation Bonus:", liquidationBonus.toString());

        // Get debt asset price and decimals
        const debtAssetPrice = await getAssetPrice(debtAsset, unhealthyUser.pool);
        const debtDecimals = await getTokenDecimals(debtAsset);

        console.log("Collateral Price:", collateralPrice.toString());
        console.log("Debt Asset Price:", debtAssetPrice.toString());
        console.log("Collateral Decimals:", collateralDecimals);
        console.log("Debt Decimals:", debtDecimals);

        // https://aave.com/docs/developers/liquidations#executing-the-liquidation-call
        // maxAmountOfCollateralToLiquidate = (debtAssetPrice * debtToCover * liquidationBonus) / collateralPrice
        // Note: liquidationBonus is stored as basis points (e.g., 10500 = 105% = 5% bonus)
        // Oracle prices are typically in 8 decimals (USD price with 8 decimal places)

        const debtToCover = cover.eq(constants.MaxUint256) ? checkedBal : cover;

        // Calculate with proper decimal handling
        // The formula needs to account for:
        // 1. debtToCover is in debt token units (with debtDecimals)
        // 2. Prices are in oracle decimals (usually 8 for USD prices)
        // 3. Result should be in collateral token units (with collateralDecimals)
        // 4. liquidationBonus is in basis points (10000 = 100%)

        // Assuming oracle prices are in 8 decimals (typical for USD prices)
        const oracleDecimals = 8;

        // Formula: maxCollateral = (debtPrice * debtToCover * liquidationBonus) / (collateralPrice * 10000)
        // But we need to adjust for decimal differences:
        // - debtPrice is in oracleDecimals
        // - debtToCover is in debtDecimals 
        // - collateralPrice is in oracleDecimals
        // - Result should be in collateralDecimals

        const maxAmountOfCollateralToLiquidate = debtAssetPrice
          .mul(debtToCover)
          .mul(liquidationBonus)
          .div(collateralPrice)
          .div(10000)
          // Adjust for decimal differences: we need to convert from debt token decimals to collateral token decimals
          .mul(BigNumber.from(10).pow(collateralDecimals))
          .div(BigNumber.from(10).pow(debtDecimals));

        console.log("Max Amount of Collateral to Liquidate:", maxAmountOfCollateralToLiquidate.toString());
        console.log("Debt to Cover:", debtToCover.toString());
        console.log("Liquidation Bonus (basis points):", liquidationBonus.toString());

        // Add human-readable versions for debugging
        const collateralPriceFormatted = utils.formatUnits(collateralPrice, oracleDecimals);
        const debtPriceFormatted = utils.formatUnits(debtAssetPrice, oracleDecimals);
        const debtToCoverFormatted = utils.formatUnits(debtToCover, debtDecimals);
        const maxCollateralFormatted = utils.formatUnits(maxAmountOfCollateralToLiquidate, collateralDecimals);

        console.log("Formatted Collateral Price (USD): $" + collateralPriceFormatted);
        console.log("Formatted Debt Price (USD): $" + debtPriceFormatted);
        console.log("Formatted Debt to Cover:", debtToCoverFormatted);
        console.log("Formatted Max Collateral to Liquidate:", maxCollateralFormatted);

        // Verify the calculation makes sense
        const debtValueUSD = parseFloat(debtPriceFormatted) * parseFloat(debtToCoverFormatted);
        const collateralValueUSD = parseFloat(collateralPriceFormatted) * parseFloat(maxCollateralFormatted);
        const liquidationBonusPercent = liquidationBonus.toNumber() / 100; // Convert basis points to percentage

        console.log("Debt Value (USD):", debtValueUSD.toFixed(2));
        console.log("Collateral Value (USD):", collateralValueUSD.toFixed(2));
        console.log("Liquidation Bonus (%):", liquidationBonusPercent + "%");
        console.log("Expected Collateral Value with Bonus (USD):", (debtValueUSD * liquidationBonusPercent / 100).toFixed(2));

        const swapParams = await routerQuoteManager.getLiquidationSwapParams(
          collateralAsset,
          debtAsset,
          maxAmountOfCollateralToLiquidate,
          config.contracts.wflow
        );

        const lParam = {
          collateralAsset,
          debtAsset,
          user: unhealthyUser.user,
          amount: checkedBal,
          transferAmount: 0,
          debtToCover: cover,
        };

        const sParamsToRepayLoan = swapParams.sParamsToRepayLoan;
        const sParamsToSendToReceiver = swapParams.sParamsToSendToReceiver;
        const receiver = "0x55203706a5EdCb1C8A6cc6e273FcB4b49dbe8FD5" // liquidator.address;

        console.log('Formatted liquidation parameters:');
        console.log('lParam:', formatHexToDecimal(lParam));
        console.log('sParamsToRepayLoan:', formatHexToDecimal(sParamsToRepayLoan));
        console.log('sParamsToSendToReceiver:', formatHexToDecimal(sParamsToSendToReceiver));
        console.log('receiver:', receiver);
        // TODO: add divide by 2 recursivelly
        try {
          // const tx = await botContract
          //   .connect(liquidator)
          //   .execute(lParam, sParamsToRepayLoan, sParamsToSendToReceiver, receiver);
          // const txReceipt = await tx.wait();
          // console.log('txReceipt', txReceipt);
          // try {
          //   const bot = new Telegraf(config.bot_token);
          //   await bot.telegram.sendMessage(
          //     config.alert_chat_id, `Liquidation for user ${unhealthyUser.user} completed. TxId: ${txReceipt.transactionHash}`);
          // } catch (err) {
          //   console.error("Error sending message:", err);
          // }
        } catch (err) {
          const revertReason = err?.error?.reason || err?.reason || err?.data || err.message;
          console.error("Transaction reverted:", revertReason);
          // try {
          //   const bot = new Telegraf(config.bot_token);
          //   await bot.telegram.sendMessage(
          //     config.alert_chat_id, `Liquidation for user ${unhealthyUser.user} failed. Reason: ${revertReason.slice(0, 100)}`);
          // } catch (err) {
          //   console.error("Error sending message:", err);
          // }
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
      // try {
      //   const bot = new Telegraf(config.bot_token);
      //   await bot.telegram.sendMessage(
      //     config.alert_chat_id, `No collateral or debt for user ${unhealthyUser.user}. HF: ${(unhealthyUser.healthFactor.toString() / 1e18).toFixed(2)}`);
      // } catch (err) {
      //   console.error("Error sending message:", err);
      // }
    }
  }
}

// Handler for AWS Lambda. Comment out to run locally.
// exports.handler = async (event) => {
//   console.log("Event received:", event);
//   try {
//     await main()
//     return {
//       statusCode: 200,
//       body: JSON.stringify({ message: "OK" }),
//     };
//   } catch (error) {
//     console.error(error);
//     return {
//       statusCode: 500,
//       body: JSON.stringify({ message: "Error" }),
//     };
//   }
// };

main()