const gql = require("graphql-tag");

const usersQuery = gql`
  {
    users {
      id
    }
  }
`;

module.exports = {
  usersQuery,
};
