import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAdminToken } from '../authutil.js';
import { verifySession } from '../auth-user.js';
import { query } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    admin?: { adminId: number; username: string };
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const uid = await verifySession(req.cookies.eb_sess || '');
  if (!uid) {
    await reply.code(401).send({ error: 'Sign in to continue' });
    return;
  }
  req.userId = uid;
}

/** Require a valid admin session cookie, and that the admin isn't disabled. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = (req as any).cookies?.eb_admin as string | undefined;
  const a = token ? await verifyAdminToken(token) : null;
  if (!a) {
    await reply.code(401).send({ error: 'Admin sign-in required' });
    return;
  }
  req.admin = a;
}

export async function audit(actor: string, action: string, detail: unknown, ip?: string): Promise<void> {
  await query(`insert into audit_log(actor, action, detail, ip) values ($1,$2,$3,$4)`, [
    actor,
    action,
    JSON.stringify(detail ?? {}),
    ip ?? null,
  ]);
}
