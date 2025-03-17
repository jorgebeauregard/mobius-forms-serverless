// config/db.ts
import * as sql from 'mssql';

const dbConfig: sql.config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true, // Use encryption
    trustServerCertificate: false,
  },
};

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export const getPool = async (): Promise<sql.ConnectionPool> => {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(dbConfig)
      .connect()
      .then(pool => {
        console.log("Connected to SQL Server");
        return pool;
      })
      .catch(err => {
        console.error("Database connection error:", err);
        throw err;
      });
  }
  return poolPromise;
};

export { sql };