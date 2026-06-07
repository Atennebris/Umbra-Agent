module Umbra.Daemon
  ( Config(..)
  , DaemonError(..)
  , runDaemon
  , startServer
  ) where

import Control.Monad (when)
import Data.IORef
import qualified Data.Map.Strict as Map

data Config = Config
  { configHost :: String
  , configPort :: Int
  } deriving (Show, Eq)

data DaemonError
  = BindError String
  | ConnectionRefused
  deriving (Show)

newtype Registry a = Registry { unRegistry :: IORef (Map.Map String a) }

class Service a where
  start :: a -> IO ()
  stop :: a -> IO ()

data Daemon = Daemon { daemonConfig :: Config }

instance Service Daemon where
  start d = putStrLn $ "Starting on " ++ configHost (daemonConfig d)
  stop _ = putStrLn "Stopping daemon"

runDaemon :: Config -> IO (Either DaemonError ())
runDaemon config = do
  let daemon = Daemon { daemonConfig = config }
  start daemon
  return (Right ())

startServer :: String -> Int -> IO ()
startServer host port = do
  let config = Config { configHost = host, configPort = port }
  result <- runDaemon config
  when (either (const True) (const False) result) $
    putStrLn "Daemon failed to start"

defaultConfig :: Config
defaultConfig = Config { configHost = "127.0.0.1", configPort = 9876 }
