const READ_METHODS = new Set(['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getBlockByNumber', 'eth_getBlockByHash']);

// A load-balanced Robinhood endpoint can return a block before every node can read it.
// Preserve the exact request/snapshot. Never retry a send or a contract revert here.
export function withRpcReadRetry(request, { attempts = 8, delayMs = 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async args => {
    for (let attempt = 1; ; attempt++) {
      try { return await request(args); }
      catch (error) {
        let text = '', cause = error;
        for (let i = 0; cause && i < 6; i++, cause = cause.cause) text += ' ' + (cause.details ?? cause.message ?? '');
        if (!READ_METHODS.has(args.method) || !/unsupported block number|header not found|block not found/i.test(text) || attempt >= attempts) throw error;
        await sleep(delayMs);
      }
    }
  };
}
