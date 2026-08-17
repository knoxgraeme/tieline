use crate::support::{self, Helper as RenamedHelper, *};
use crate::deep::{nested::{Item as DeepItem, *}};
use external::single::Thing;
pub use super::shared::Item as PublicItem;
pub mod external_module;

pub struct Service;
pub struct First;
pub struct Second;
pub enum State { Ready, Failed }
pub type Alias = Service;
pub const READY: bool = true;
pub static GLOBAL: usize = 0;

pub trait Worker {
    fn run(&self);
    type Output;
    const LIMIT: usize;
}

impl Worker for Service {
    fn run(&self) {}
    type Output = ();
    const LIMIT: usize = 1;
}

impl Service {
    pub fn r#match(&self) {}
}

impl First {
    pub fn same(&self) {}
}

impl Second {
    pub fn same(&self) {}
}

#[tracing::instrument]
pub async fn top_level() {}

mod nested {
    macro_rules! adjacent { () => {}; }
    adjacent!();

    pub struct Café;

    impl Café {
        pub fn execute(&self) {}
    }
}
