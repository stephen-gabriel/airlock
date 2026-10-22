use std::convert::Infallible;

use pczt::{Pczt, roles::{signer::Signer, verifier::Verifier}};

fn main() {
    let path = std::env::args().nth(1).expect("usage: pczt_probe <file>");
    let bytes = std::fs::read(&path).expect("read");
    let pczt = Pczt::parse(&bytes).expect("parse");
    let sighash = Signer::new(pczt.clone()).expect("signer").shielded_sighash();
    let _ = Verifier::new(pczt)
        .with_ironwood::<Infallible, _>(|bundle| {
            for (i, action) in bundle.actions().iter().enumerate() {
                let spend = action.spend();
                println!("action {i}:");
                println!("  value = {:?}", spend.value().as_ref().map(|v| v.inner()));
                println!("  recipient_set = {}", spend.recipient().is_some());
                println!("  dummy_sk = {}", spend.dummy_sk().is_some());
                println!("  alpha = {}", spend.alpha().is_some());
                println!("  zip32_derivation = {}", spend.zip32_derivation().is_some());
                println!("  fvk_set = {}", spend.fvk().is_some());
                let out = action.output();
                if let Some(r) = spend.recipient().as_ref() {
                    println!("  spend_recipient_raw = {}", hex_encode(&r.to_raw_address_bytes()));
                }
                if let Some(v) = out.value().as_ref() {
                    println!("  output_value = {}", v.inner());
                }
                if let Some(r) = out.recipient().as_ref() {
                    println!("  output_recipient_raw = {}", hex_encode(&r.to_raw_address_bytes()));
                }
                if let Some(fvk) = spend.fvk() {
                    println!("  fvk_hex = {}", hex_encode(&fvk.to_bytes()));
                }
                match spend.spend_auth_sig().as_ref() {
                    Some(sig) => {
                        let ok = spend.rk().verify(&sighash, sig).is_ok();
                        println!("  spend_auth_sig = present (valid_for_sighash = {ok})");
                    }
                    None => println!("  spend_auth_sig = None"),
                }
            }
            Ok::<(), pczt::roles::verifier::OrchardError<Infallible>>(())
        })
        .expect("verify");
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
