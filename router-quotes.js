const { utils, Contract, BigNumber } = require("ethers");

// Import ABIs for different router types
const V2RouterAbi = require("./abis/routers/v2.json");
const V3QuoterAbi = require("./abis/routers/v3.json");
const AgroKittyRouterAbi = require("./abis/routers/agrokitty.json");
const ERC20Abi = require("./abis/ERC20Abi.json");

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

// Swap types enum to match the contract
const SwapType = {
  UNISWAP_V2: 0,
  UNISWAP_V3: 1,
  AGRO_KITTY: 2
};

class RouterQuoteManager {
  constructor(provider, config, liquidatorAddress = null, botContractAddress = null) {
    this.provider = provider;
    this.config = config;
    this.liquidatorAddress = liquidatorAddress;
    this.botContractAddress = botContractAddress;

    // Initialize router contracts
    this.v2Router = new Contract(config.contracts.punch.router, V2RouterAbi, provider);
    this.v3Quoter = new Contract(config.contracts.trado.quoter, V3QuoterAbi, provider);
    this.agroKittyRouter = new Contract(config.contracts.agrokitty.router, AgroKittyRouterAbi, provider);
  }

  /**
 * Get quote from Uniswap V2 style router (Punch)
 */
  async getV2Quote(tokenIn, tokenOut, amountIn) {
    try {
      const path = [tokenIn, tokenOut];

      // For V2 quotes, we use bot contract address for simulation since during liquidation,
      // swaps happen from the bot contract (which receives flashloan) not the liquidator
      // Note: Static calls may still fail if bot contract lacks tokens/approvals for simulation

      // Method 1: Use getAmountsOut for accurate quotes without token transfers
      try {
        const amounts = await this.v2Router.getAmountsOut(amountIn, path);

        if (amounts && amounts.length > 1) {
          const amountOut = amounts[amounts.length - 1];
          return {
            swapType: SwapType.UNISWAP_V2,
            router: this.config.contracts.punch.router,
            path: utils.defaultAbiCoder.encode(["address[]"], [path]),
            amountIn: amountIn,
            amountOut: amountOut,
            amountOutMin: amountOut.mul(995).div(1000), // 0.5% slippage
            adapters: []
          };
        }
      } catch (quoteError) {
        console.log(`V2 Router (${this.config.contracts.punch.router}) getAmountsOut failed:`);
        console.log(`  Error: ${quoteError.message}`);
        console.log(`  Code: ${quoteError.code || 'N/A'}`);
        console.log(`  Reason: ${quoteError.reason || 'N/A'}`);
        console.log(`  Path: ${path.join(' -> ')}`);
        console.log(`  Amount In: ${amountIn.toString()}`);
        console.log("  Using fallback estimation instead");
      }

      // Method 2: Fallback to conservative estimate (similar to other DEX aggregators)
      // Assume 0.3% fee + 1% spread for conservative estimate
      const estimatedOut = amountIn.mul(987).div(1000); // 1.3% total cost estimate

      return {
        swapType: SwapType.UNISWAP_V2,
        router: this.config.contracts.punch.router,
        path: utils.defaultAbiCoder.encode(["address[]"], [path]),
        amountIn: amountIn,
        amountOut: estimatedOut,
        amountOutMin: estimatedOut.mul(995).div(1000), // 0.5% slippage
        adapters: []
      };
    } catch (error) {
      console.error(`V2 Router Quote Error (${this.config.contracts.punch.router}):`);
      console.error(`  Error: ${error.message}`);
      console.error(`  Code: ${error.code || 'N/A'}`);
      console.error(`  Reason: ${error.reason || 'N/A'}`);
      console.error(`  Function: getV2Quote`);
      console.error(`  TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}`);
      return null;
    }
  }

  /**
 * Get quote from Uniswap V3 style router (Trado)
 */
  async getV3Quote(tokenIn, tokenOut, amountIn) {
    try {
      // Test multiple fee tiers like in the Solidity version
      const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

      let bestAmountOut = BigNumber.from(0);
      let bestFee = 3000;
      let bestPath = null;

      console.log(`  Testing V3 fee tiers for ${tokenIn} -> ${tokenOut}:`);

      // Test each fee tier and find the best quote
      for (const fee of feeTiers) {
        try {
          // Encode path for V3 (token -> fee -> token)
          const path = utils.solidityPack(
            ["address", "uint24", "address"],
            [tokenIn, fee, tokenOut]
          );

          const quoteResult = await this.v3Quoter.quoteExactInput(path, amountIn);

          // quoteExactInput returns [amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate]
          // We only need the first value (amountOut)
          const amountOut = quoteResult[0] || quoteResult; // Handle both array and single return value

          if (amountOut && amountOut.gt(bestAmountOut)) {
            bestAmountOut = amountOut;
            bestFee = fee;
            bestPath = path;
            console.log(`    Fee ${fee}: ${amountOut.toString()} ✅ (new best)`);
          } else if (amountOut && amountOut.gt(0)) {
            console.log(`    Fee ${fee}: ${amountOut.toString()}`);
          }
        } catch (feeError) {
          console.log(`    Fee ${fee}: FAILED (${feeError.reason || 'no pool or insufficient liquidity'})`);
          continue; // Try next fee tier
        }
      }

      // If we found a valid quote, return it
      if (bestAmountOut.gt(0) && bestPath) {
        console.log(`  Best V3 quote: ${bestAmountOut.toString()} at ${bestFee} bps fee`);
        return {
          swapType: SwapType.UNISWAP_V3,
          router: this.config.contracts.trado.router,
          path: bestPath,
          amountIn: amountIn,
          amountOut: bestAmountOut,
          amountOutMin: bestAmountOut.mul(995).div(1000), // 0.5% slippage
          adapters: []
        };
      }

      console.log(`  No valid V3 pools found for any fee tier`);

      // If no fee tier worked, return null (don't use fallback estimate)
      return null;
    } catch (error) {
      console.error(`V3 Router Quote Error (${this.config.contracts.trado.router}):`);
      console.error(`  Error: ${error.message}`);
      console.error(`  Code: ${error.code || 'N/A'}`);
      console.error(`  Reason: ${error.reason || 'N/A'}`);
      console.error(`  Function: getV3Quote`);
      console.error(`  TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}`);
      return null;
    }
  }

  /**
 * Get quote from AgroKitty router
 */
  async getAgroKittyQuote(tokenIn, tokenOut, amountIn, adapters = []) {
    try {
      // AgroKitty uses a custom Trade struct for swaps
      const trade = {
        amountIn: amountIn,
        amountOut: 0, // Will be determined by the router
        path: [tokenIn, tokenOut],
        adapters: adapters
      };

      // Method 1: Use findBestPath for accurate quotes without token transfers
      try {
        const maxSteps = 4; // Reasonable limit for path finding
        const formattedOffer = await this.agroKittyRouter.findBestPath(
          amountIn,
          tokenIn,
          tokenOut,
          maxSteps
        );
        console.log('tokenIn', tokenIn);
        console.log('tokenOut', tokenOut);
        console.log('amountIn', amountIn.toString());
        console.log('formattedOffer', formatHexToDecimal(formattedOffer));

        // Use the updated FormattedOffer structure: { amounts[], adapters[], path[], gasEstimate }
        const amounts = formattedOffer.amounts || formattedOffer[0] || [];
        const amountOut = amounts.length > 0 ? amounts[amounts.length - 1] : null; // Last amount is final output
        const bestPath = formattedOffer.path || [tokenIn, tokenOut];
        const bestAdapters = formattedOffer.adapters || [];
        const gasEstimate = formattedOffer.gasEstimate || 0;

        console.log(`  AgroKitty result:`);
        console.log(`    Amounts array: [${amounts.map(a => a.toString()).join(', ')}]`);
        console.log(`    Final AmountOut: ${amountOut ? amountOut.toString() : 'null'}`);
        console.log(`    Path: ${bestPath.join(' -> ')}`);
        console.log(`    Adapters: ${bestAdapters.join(', ') || 'None'}`);
        console.log(`    Gas Estimate: ${gasEstimate.toString()}`);

        // Validate the amount - if it's suspiciously small compared to input, it might be an error
        // const minExpectedOut = amountIn.div(1000); // At least 0.1% of input seems reasonable

        if (amountOut && amountOut.gt(0)) {
          // if (amountOut.lt(minExpectedOut)) {
          //   console.log(`    ⚠️  Amount too small (${amountOut.toString()}) vs input (${amountIn.toString()}) - likely no valid path`);
          //   // Return null instead of this tiny amount
          //   return null;
          // }
          return {
            swapType: SwapType.AGRO_KITTY,
            router: this.config.contracts.agrokitty.router,
            path: utils.defaultAbiCoder.encode(["address[]"], [bestPath]),
            amountIn: amountIn,
            // amountOut: amountOut,
            amountOutMin: amountOut.mul(990).div(1000), // 1% slippage for AgroKitty
            adapters: bestAdapters
          };
        }
      } catch (quoteError) {
        console.log(`AgroKitty Router (${this.config.contracts.agrokitty.router}) findBestPath failed:`);
        console.log(`  Error: ${quoteError.message}`);
        console.log(`  Code: ${quoteError.code || 'N/A'}`);
        console.log(`  Reason: ${quoteError.reason || 'N/A'}`);
        console.log(`  TokenIn: ${tokenIn}, TokenOut: ${tokenOut}`);
        console.log(`  Amount In: ${amountIn.toString()}`);
        console.log("  Using fallback estimation instead");
      }
    } catch (error) {
      console.error(`AgroKitty Router Quote Error (${this.config.contracts.agrokitty.router}):`);
      console.error(`  Error: ${error.message}`);
      console.error(`  Code: ${error.code || 'N/A'}`);
      console.error(`  Reason: ${error.reason || 'N/A'}`);
      console.error(`  Function: getAgroKittyQuote`);
      console.error(`  TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}`);
      return null;
    }
  }

  /**
 * Get quotes from all routers and return the best one
 */
  async getBestQuote(tokenIn, tokenOut, amountIn) {
    console.log(`\n--- Getting quotes for ${amountIn.toString()} ${tokenIn} -> ${tokenOut} ---`);

    // Get quotes from all routers in parallel
    // const [v2Quote, v3Quote, agroKittyQuote] = await Promise.all([
    //   this.getV2Quote(tokenIn, tokenOut, amountIn),
    //   this.getV3Quote(tokenIn, tokenOut, amountIn),
    //   this.getAgroKittyQuote(tokenIn, tokenOut, amountIn, [])
    // ]);
    const [agroKittyQuote] = await Promise.all([
      // this.getV2Quote(tokenIn, tokenOut, amountIn),
      // this.getV3Quote(tokenIn, tokenOut, amountIn),
      this.getAgroKittyQuote(tokenIn, tokenOut, amountIn, [])
    ]);

    // Log detailed results for each router
    console.log("Quote Results Summary:");
    // console.log(`  V2 (Punch): ${v2Quote ? v2Quote.amountOutMin.toString() : 'FAILED'}`);
    // console.log(`  V3 (Trado): ${v3Quote ? v3Quote.amountOutMin.toString() : 'FAILED'}`);
    console.log(`  AgroKitty: ${agroKittyQuote ? agroKittyQuote.amountOutMin.toString() : 'FAILED'}`);

    // Filter out null quotes
    const validQuotes = [agroKittyQuote].filter(quote => quote !== null);
    // const validQuotes = [v2Quote, v3Quote, agroKittyQuote].filter(quote => quote !== null);

    if (validQuotes.length === 0) {
      console.log("❌ No valid quotes found from any router");
      return null;
    }

    // Sort by amountOut (descending) to get the best quote
    validQuotes.sort((a, b) => {
      if (a.amountOut.gt(b.amountOut)) return -1;
      if (a.amountOut.lt(b.amountOut)) return 1;
      return 0;
    });

    const bestQuote = validQuotes[0];
    // const routerNames = ['V2 (Punch)', 'V3 (Trado)', 'AgroKitty'];
    const routerNames = ['AgroKitty'];
    console.log(`✅ Best quote: ${bestQuote.amountOutMin.toString()} from ${routerNames[bestQuote.swapType]}`);

    // Show comparison with other quotes
    if (validQuotes.length > 1) {
      console.log("Other quotes for comparison:");
      validQuotes.slice(1).forEach((quote, index) => {
        const improvement = bestQuote.amountOutMin.sub(quote.amountOutMin);
        const improvementPct = improvement.mul(10000).div(quote.amountOutMin).toNumber() / 100;
        console.log(`  ${routerNames[quote.swapType]}: ${quote.amountOutMin.toString()} (-${improvement.toString()}, -${improvementPct.toFixed(2)}%)`);
      });
    }

    return bestQuote;
  }

  /**
 * Get the best swap parameters for liquidation
 */
  async getLiquidationSwapParams(collateralAsset, debtAsset, collateralAmount, wflowAddress) {
    try {
      console.log(`\n=== Getting Liquidation Swap Parameters ===`);
      console.log(`Collateral Asset: ${collateralAsset}`);
      console.log(`Debt Asset: ${debtAsset}`);
      console.log(`Collateral Amount: ${collateralAmount.toString()}`);
      console.log(`WFLOW Address: ${wflowAddress}`);

      // Get quote for collateral -> debt (to repay loan)
      console.log(`\n--- Getting quote for collateral -> debt (repay loan) ---`);
      const repayQuote = await this.getBestQuote(collateralAsset, debtAsset, collateralAmount);

      if (repayQuote) {
        console.log(`Best repay quote: ${repayQuote.amountOutMin.toString()} from router type ${repayQuote.swapType}`);
      } else {
        console.log(`No valid repay quote found, using default parameters`);
      }

      // Get quote for debt -> WFLOW (to send to receiver)
      const debtAmountForReceiver = repayQuote ? repayQuote.amountOutMin : BigNumber.from(0);
      console.log(`\n--- Getting quote for debt -> WFLOW (send to receiver) ---`);
      console.log(`Debt amount for receiver swap: ${debtAmountForReceiver.toString()}`);

      let receiverQuote = null;

      // Check if debt asset is already WFLOW - no swap needed!
      if (debtAsset.toLowerCase() === wflowAddress.toLowerCase()) {
        console.log(`✅ Debt asset IS WFLOW - no swap needed for receiver!`);
        console.log(`   Will directly send ${debtAmountForReceiver.toString()} WFLOW to receiver`);

        // Create a "dummy" quote that represents no swap (same token in/out)
        receiverQuote = {
          swapType: SwapType.UNISWAP_V2, // Default type (won't be used since no swap)
          router: this.config.contracts.punch.router,
          path: utils.defaultAbiCoder.encode(["address[]"], [[debtAsset, wflowAddress]]),
          amountIn: debtAmountForReceiver,
          // amountOut: debtAmountForReceiver, // 1:1 ratio since same token
          amountOutMin: debtAmountForReceiver, // No slippage risk
          adapters: []
        };
      } else {
        console.log(`   Debt asset (${debtAsset}) != WFLOW (${wflowAddress}) - getting swap quote`);
        receiverQuote = debtAmountForReceiver.gt(0) ?
          await this.getBestQuote(debtAsset, wflowAddress, debtAmountForReceiver) : null;

        if (receiverQuote) {
          console.log(`Best receiver quote: ${receiverQuote.amountOutMin.toString()} from router type ${receiverQuote.swapType}`);
        } else {
          console.log(`No valid receiver quote found, using default parameters`);
        }
      }

      // Use the best quotes when available, only fall back to defaults if no quotes found
      const sParamsToRepayLoan = repayQuote || {
        swapType: SwapType.UNISWAP_V2,
        router: this.config.contracts.punch.router,
        path: utils.defaultAbiCoder.encode(["address[]"], [[collateralAsset, debtAsset]]),
        amountIn: collateralAmount,
        amountOutMin: 0,
        adapters: []
      };

      const sParamsToSendToReceiver = receiverQuote || {
        swapType: SwapType.UNISWAP_V2,
        router: this.config.contracts.punch.router,
        path: utils.defaultAbiCoder.encode(["address[]"], [[debtAsset, wflowAddress]]),
        amountIn: debtAmountForReceiver,
        amountOutMin: 0,
        adapters: []
      };

      const result = {
        sParamsToRepayLoan,
        sParamsToSendToReceiver
      };

      // Log which routers were actually selected
      const routerNames = ['V2 (Punch)', 'V3 (Trado)', 'AgroKitty'];
      console.log(`\n🎯 Selected Routers:`);
      console.log(`  Repay Loan: ${routerNames[sParamsToRepayLoan.swapType]} (${sParamsToRepayLoan.router})`);
      console.log(`  Send to Receiver: ${routerNames[sParamsToSendToReceiver.swapType]} (${sParamsToSendToReceiver.router})`);

      console.log(`\n=== Final Swap Parameters ===`);
      console.log(`Repay Loan Swap:`, result.sParamsToRepayLoan);
      console.log(`Send to Receiver Swap:`, result.sParamsToSendToReceiver);

      return result;
    } catch (error) {
      console.error("Error getting liquidation swap params:", error);
      // Return default parameters in case of error
      return {
        sParamsToRepayLoan: {
          swapType: SwapType.UNISWAP_V2,
          router: this.config.contracts.punch.router,
          path: utils.defaultAbiCoder.encode(["address[]"], [[collateralAsset, debtAsset]]),
          amountIn: collateralAmount,
          amountOutMin: 0,
          adapters: []
        },
        sParamsToSendToReceiver: {
          swapType: SwapType.UNISWAP_V2,
          router: this.config.contracts.punch.router,
          path: utils.defaultAbiCoder.encode(["address[]"], [[debtAsset, wflowAddress]]),
          amountIn: 0,
          amountOutMin: 0,
          adapters: []
        }
      };
    }
  }
}

module.exports = { RouterQuoteManager, SwapType }; 