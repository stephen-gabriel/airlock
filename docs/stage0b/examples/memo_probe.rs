use std::convert::Infallible;
use std::io::Read;

use anyhow::anyhow;
use bip0039::{English, Mnemonic};
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use pczt::{Pczt, roles::verifier::Verifier};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;
use zip32::AccountId;

fn main() -> Result<(), anyhow::Error> {
    let mut a = std::env::args().skip(1);
    let wallet = a.next().expect("wallet dir");
    let identity = a.next().expect("identity file");
    let file = a.next().expect("pczt file");

    let keys_str = std::fs::read_to_string(format!("{wallet}/keys.toml"))?;
    #[derive(serde::Deserialize)]
    struct Keys {
        mnemonic: Option<String>,
    }
    let keys: Keys = toml::from_str(&keys_str)?;
    let ciphertext = keys.mnemonic.ok_or_else(|| anyhow!("no mnemonic in keys.toml"))?;

    let identities = age::IdentityFile::from_file(identity)?.into_identities()?;
    let decryptor = age::Decryptor::new(age::armor::ArmoredReader::new(ciphertext.as_bytes()))?;
    let mut buf = vec![];
    decryptor
        .decrypt(identities.iter().map(|i| i.as_ref() as _))?
        .read_to_end(&mut buf)?;
    let phrase = std::str::from_utf8(&buf)?;
    let mnemonic = Mnemonic::<English>::from_phrase(phrase)?;
    let seed = mnemonic.to_seed("");

    let usk = UnifiedSpendingKey::from_seed(&Network::TestNetwork, &seed, AccountId::ZERO)?;
    let sk: &SpendingKey = usk.orchard();
    let fvk = FullViewingKey::from(sk);
    let ivk_ext = fvk.to_ivk(Scope::External).prepare();
    let ivk_int = fvk.to_ivk(Scope::Internal).prepare();

    let pczt = Pczt::parse(&std::fs::read(&file)?).map_err(|e| anyhow!("{e:?}"))?;
    let _ = Verifier::new(pczt)
        .with_ironwood::<Infallible, _>(|bundle| {
            let ver = *bundle.bundle_version();
            for (i, action) in bundle.actions().iter().enumerate() {
                let r = action
                    .decrypt_output_with_ivk(&ivk_ext, ver)
                    .and_then(|o| {
                        if o.is_some() {
                            Ok(o)
                        } else {
                            action.decrypt_output_with_ivk(&ivk_int, ver)
                        }
                    });
                match r {
                    Ok(Some((_note, _addr, memo))) => {
                        let text = if memo[0] == 0xf4 {
                            let end = memo[1..].iter().position(|&b| b == 0).unwrap_or(511);
                            String::from_utf8_lossy(&memo[1..1 + end]).to_string()
                        } else {
                            format!("<tag {:02x}>", memo[0])
                        };
                        println!(
                            "action {i}: decrypts with IVK; memo_tag={:02x} memo_text={text:?}",
                            memo[0]
                        );
                    }
                    Ok(None) => println!("action {i}: not decryptable with IVK"),
                    Err(e) => println!("action {i}: error {e:?}"),
                }
            }
            Ok::<(), pczt::roles::verifier::OrchardError<Infallible>>(())
        })
        .map_err(|e| anyhow!("{e:?}"))?;
    Ok(())
}
