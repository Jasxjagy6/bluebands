import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from './guards.js';
import { convert,quoteConversion,conversionHistory,ConversionError } from '../conversions.js';
import { MarketUnavailable } from '../games/prices.js';

export async function conversionRoutes(app:FastifyInstance){
  app.addHook('preHandler',requireUser);
  const handle=(reply:import('fastify').FastifyReply,error:unknown)=>{
    if(error instanceof ConversionError)return reply.code(error.statusCode).send({error:error.message});
    if(error instanceof MarketUnavailable)return reply.code(503).send({error:error.message});
    const msg=(error as Error).message;
    if(/^(Invalid amount|At most)/.test(msg))return reply.code(400).send({error:msg});
    throw error;
  };
  app.post('/api/me/conversions/quote',async(req,reply)=>{
    const b=z.object({asset:z.string().min(1).max(32),direction:z.enum(['crypto_to_coins','coins_to_crypto']),amount:z.string().regex(/^\d{1,50}(\.\d{1,18})?$/)}).strict().safeParse(req.body);
    if(!b.success)return reply.code(400).send({error:'Enter a valid conversion amount and currency'});
    try{return await quoteConversion(req.userId!,b.data.asset,b.data.direction,b.data.amount);}catch(e){return handle(reply,e);}
  });
  app.post('/api/me/conversions',async(req,reply)=>{
    const b=z.object({request:z.string().uuid(),quote:z.string().uuid()}).strict().safeParse(req.body);
    if(!b.success)return reply.code(400).send({error:'Review a fresh conversion quote first'});
    try{return await convert(req.userId!,b.data.request,b.data.quote);}catch(e){return handle(reply,e);}
  });
  app.get('/api/me/conversions',req=>conversionHistory(req.userId!,z.object({page:z.coerce.number().int().min(0).max(100000).default(0)}).parse(req.query).page));
}
