# More Liquidation Bot

#### Requirements

- [Node.js](https://nodejs.org/en) v18 or later
- Liquidate execute address should have sufficient WFLOW or ankr.FLOW

#### How To Run Bot

- Create `config.json` and add values

* Note: Please set the liquidate executor's private key correctly

```
{
  "subgraph_url": "https://graph.more.markets/subgraphs/name/more-markets/more-subgraph",
  "rpc_url": "https://mainnet.evm.nodes.onflow.org",
  "liquidator_key": "your_liquidation_executor_private_key",
  "contracts": {
    "pool": "0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d",
    "multicall": "0x8358d18E99F44E39ea90339c4d6E8C36101f8161"
  }
}
```

- Install npm packages

```
npm run install
or
yarn install
```

- Deploy on AWS EC2 instance or any hosting service
- Then setup cron to run this script with your certain interval
  Check this [Guide](https://www.swhosting.com/en/comunidad/manual/how-to-use-cron-to-automate-tasks-in-ubuntu-2204debian-11)
