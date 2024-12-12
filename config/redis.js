const baseNodes = [
  { host: process.env.REDIS_MASTER1, port: 6379 },  // master1
  { host: process.env.REDIS_MASTER2, port: 6379 },   // master2
  { host: process.env.REDIS_MASTER3, port: 6379 }    // master3
];

const redisConfig = {
  development: {
    nodes: baseNodes
  },
  production: {
    nodes: baseNodes.map(node => ({
      ...node,
      host: `redis-master-${node.host.split('.')[3]}`
    }))
  }
};