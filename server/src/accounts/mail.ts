// Envío de los códigos de acceso. El proveedor real se configurará en una tarea
// posterior; hasta entonces solo existen el correo simulado de las pruebas
// (test/accountsHarness.ts) y la consola de `wrangler dev` local (config.ts).

export type CodePurpose = 'sign-in' | 'email-verification';

export interface AccountMailer {
  sendCode(message: { to: string; code: string; purpose: CodePurpose }): Promise<void>;
}
