import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvoiceError, OxaPay, ownedInvoices } from '../oxapay.js';
import { requireUser } from './guards.js';

const invoiceRequest=z.object({asset:z.string().min(1).max(32),amount:z.string().min(1).max(78),request:z.string().uuid()}).strict();

export async function oxapayRoutes(app:FastifyInstance,{service=new OxaPay()}:{service?:OxaPay}) {
  app.register(async player=>{
    player.addHook('preHandler',requireUser);
    player.post('/api/me/oxapay/invoices',async(req,reply)=>{
      const input=invoiceRequest.safeParse(req.body);
      if(!input.success)return reply.code(400).send({error:'Check the invoice details'});
      try {
        const invoice=await service.create(req.userId!,input.data);
        return reply.code(invoice.status==='creating'?202:200).send(invoice);
      } catch(e){if(e instanceof InvoiceError)return reply.code(e.statusCode).send({error:e.message});throw e;}
    });
    player.get('/api/me/oxapay/invoices',async req=>({invoices:await ownedInvoices(req.userId!)}));
    player.get('/api/me/oxapay/invoices/:id',async(req,reply)=>{
      const p=z.object({id:z.string().uuid()}).safeParse(req.params);
      const invoice=p.success?(await ownedInvoices(req.userId!,p.data.id))[0]:undefined;
      return invoice??reply.code(404).send({error:'Invoice unavailable'});
    });
  });

  app.register(async callback=>{
    callback.removeContentTypeParser('application/json');
    callback.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,bytes,done)=>done(null,bytes));
    callback.post('/api/oxapay/webhook',{bodyLimit:64*1024},async(req,reply)=>{
      if(!Buffer.isBuffer(req.body))return reply.code(415).send({error:'Expected a JSON callback'});
      try {await service.webhook(req.body,req.headers.hmac);}
      catch(e){
        if(e instanceof InvoiceError)return reply.code(e.statusCode).send({error:e.message});
        req.log.warn('OxaPay callback verification deferred');
        return reply.code(503).send({error:'Payment verification temporarily unavailable'});
      }
      // https://docs.oxapay.com/webhook specifies HTTP 200 with the literal body "ok".
      return reply.type('text/plain').send('ok');
    });
  });

  let timer:NodeJS.Timeout|undefined, work:Promise<void>|undefined;
  app.addHook('onReady',async()=>{
    const tick=()=>{work??=service.reconcile().catch(()=>{app.log.warn('OxaPay reconciliation deferred');}).finally(()=>{work=undefined;});};
    timer=setInterval(tick,15000); timer.unref();
  });
  app.addHook('onClose',async()=>{clearInterval(timer);await work;});
}
