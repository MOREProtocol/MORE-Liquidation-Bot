const gql = require("graphql-tag");

const usersQuery = gql`
  query ($first: Int, $skip: Int) {
    users(first: $first, skip: $skip, orderBy: id, orderDirection: asc) {
      id
    }
  }
`;

module.exports = {
  usersQuery,
};
