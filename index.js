const _ = require("lodash");
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

const { positionsQuery } = require("./query.js");

const config = require("./config.json");
const OracleAbi = require("./abis/OracleAbi.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);
const oraclePriceScale = constants.WeiPerEther.mul(constants.WeiPerEther); // 1e36

const apolloFetcher = async (query) => {
  const client = new ApolloClient({
    link: new HttpLink({
      uri: config.subgraph_url,
    }),
    cache: new InMemoryCache(),
  });

  return client.query({
    query: query,
    fetchPolicy: "cache-first",
  });
};

const getPairprice = async (oracle) => {
  const oracleContract = new Contract(oracle, OracleAbi, provider);
  return await oracleContract.price();
};

// exports.handler = async (event) => {
async function main() {
  let priceInfos = [];
  let unhealthPositions = [];

  // fetch positions
  const accountsInfo = await apolloFetcher(positionsQuery);
  const { accounts } = accountsInfo.data;
  for (const account of accounts) {
    let userPositions = {};
    const userAddr = account.id;

    // init user positions
    for (const position of account.positions) {
      const idSplit = position.id.split("-");
      const marketId = idSplit[1];
      const positionType = idSplit[2];

      if (_.isEmpty(userPositions[marketId])) {
        const priceInd = priceInfos.find(
          (priceInfo) => priceInfo.marketId == marketId
        );
        const selPrice = _.isEmpty(priceInd)
          ? await getPairprice(position.market.oracle.oracleAddress)
          : priceInd.price;
        userPositions[marketId] = {
          pair_price: selPrice,
          lltv: BigNumber.from(position.market.lltv),
        };

        if (_.isEmpty(priceInd)) {
          priceInfos.push({
            marketId,
            price: selPrice,
          });
        }
      }

      if (positionType == "BORROWER") {
        let userBorrows = constants.Zero;
        for (const item of position.borrows) {
          userBorrows = userBorrows.add(BigNumber.from(item.amount));
        }

        let userRepays = constants.Zero;
        for (const item of position.repays) {
          userRepays = userRepays.add(BigNumber.from(item.amount));
        }

        userPositions[marketId].borrow = userBorrows.gte(userRepays)
          ? userBorrows.sub(userRepays)
          : constants.Zero;
      } else if (positionType == "COLLATERAL") {
        userPositions[marketId].collateral = BigNumber.from(position.balance);
      }
    }

    // check health
    if (!_.isEmpty(userPositions)) {
      for (const marketId in userPositions) {
        const userPosition = userPositions[marketId];
        if (
          _.isEmpty(userPosition.collateral) ||
          _.isEmpty(userPosition.borrow)
        )
          continue;

        if (
          userPosition.collateral.gt(constants.Zero) &&
          userPosition.borrow.gt(constants.Zero)
        ) {
          const borrowLimit = userPosition.collateral
            .mul(userPosition.lltv)
            .mul(oraclePriceScale)
            .div(constants.WeiPerEther)
            .div(userPosition.pair_price);

          if (borrowLimit.lt(userPosition.borrow)) {
            unhealthPositions.push({
              userAddr,
            });
          }
        }
      }
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit();
  })
  .finally(() => {
    console.log("finally");
    process.exit();
  });
