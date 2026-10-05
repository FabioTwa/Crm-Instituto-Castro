// IC CRM — Instituto Castro.
// Copie para config.js (que NAO vai para o git: ver .gitignore) e preencha com o
// projeto Supabase do Instituto Castro (Project Settings -> API).
// A chave aqui e a "anon" (publica por desenho, vai para o navegador). Com a RLS
// fechada (15_ic_rls.sql) ela nao le nada sem login. NUNCA coloque a
// service_role neste arquivo: ela mora so nos segredos das Edge Functions.
window.IC_CONFIG = {
    SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',      // EXEMPLO
    SUPABASE_ANON_KEY: 'COLE-AQUI-A-CHAVE-ANON-DO-PROJETO' // EXEMPLO
    //
    // MODO DEMONSTRACAO LOCAL (so para teste, so em localhost, sem Supabase). Para usar, ponha uma virgula
    // depois da linha acima e descomente o bloco abaixo, com e-mails e senhas FICTICIOS:
    // DEMO_LOCAL: {
    //     admin:     { nome: 'Admin Teste',  email: 'admin@exemplo.invalid',     senha: 'defina-uma-senha-de-teste' },
    //     atendente: { nome: 'Atendente Teste', email: 'atendente@exemplo.invalid', senha: 'defina-outra-senha-de-teste' }
    // }
};
// Carrega o backend simulado (so roda em localhost e so com DEMO_LOCAL acima).
if (window.IC_CONFIG.DEMO_LOCAL) document.write('<script src="demo/demo-local.js"></script>');
