import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moodle_logs_db';

let db: Db;
let client: MongoClient;

export const connectDB = async (): Promise<Db> => {
  if (db) return db; // Si ya existe, la reusamos (Singleton)

  try {
    client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db(DB_NAME);
    console.log(`🍃 Conectado exitosamente a MongoDB: ${DB_NAME}`);
    return db;
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    process.exit(1); // Si falla, matamos el proceso
  }
};

export const getDB = (): Db => {
  if (!db) {
    throw new Error('La base de datos no está inicializada. Llama a connectDB primero.');
  }
  return db;
};