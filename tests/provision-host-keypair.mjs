import {createClient} from '@supabase/supabase-js';
import {deriveVaultKey,encrypt,decrypt,generateAdminKeyPair,importAdminPrivateKey} from '../src/crypto.js';
import {localConfig,clientOptions} from './local-config.mjs';
const config=localConfig(),client=createClient(config.url,config.key,clientOptions);
try{
  const signed=await client.auth.signInWithPassword({email:config.email,password:config.password});if(signed.error)throw signed.error;
  const result=await client.from('hosts').select('*').eq('user_id',signed.data.user.id).single();if(result.error)throw result.error;
  const vault=await deriveVaultKey(config.password,result.data.vault_salt);
  if(result.data.private_key_cipher){await importAdminPrivateKey(JSON.parse(await decrypt(vault,result.data.private_key_cipher,'kitty-admin-private-key-v1')));console.log('PASS: existing administrator key unlocked.');}
  else{
    const pair=await generateAdminKeyPair();
    const stored=await client.rpc('set_host_keypair',{p_public_key_jwk:pair.publicJwk,p_private_key_cipher:await encrypt(vault,JSON.stringify(pair.privateJwk),'kitty-admin-private-key-v1')});
    if(stored.error)throw stored.error;console.log('PASS: administrator public key and password-encrypted private key provisioned.');
  }
}finally{await client.auth.signOut()}
