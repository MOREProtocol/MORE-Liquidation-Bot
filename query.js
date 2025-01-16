const gql = require("graphql-tag");

const positionsQuery = gql`
  {
    accounts(first: 1000) {
      id
      positions(first: 100) {
        id
        market {
          lltv
          inputToken {
            id
          }
          borrowedToken {
            id
          }
          oracle {
            oracleAddress
          }
        }
        balance
        borrows {
          amount
        }
        repays {
          amount
        }
      }
    }
  }
`;

module.exports = {
  positionsQuery,
};
