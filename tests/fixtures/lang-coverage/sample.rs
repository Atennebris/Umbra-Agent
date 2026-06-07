use std::collections::HashMap;
use std::io::{self, Read};

pub struct Config {
    values: HashMap<String, String>,
}

impl Config {
    pub fn new() -> Self {
        Config { values: HashMap::new() }
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.values.get(key)
    }
}

pub fn load_config(path: &str) -> io::Result<Config> {
    let mut content = String::new();
    io::stdin().read_to_string(&mut content)?;
    Ok(Config::new())
}

pub enum AppError {
    NotFound,
    ParseError(String),
}

pub trait Configurable {
    fn configure(&mut self, key: &str, value: &str);
}
