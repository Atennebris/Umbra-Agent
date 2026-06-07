(ns umbra.daemon
  (:require [clojure.core.async :as async]
            [clojure.data.json :as json]
            [umbra.registry :as registry]))

(def default-config
  {:host "127.0.0.1"
   :port 9876})

(defprotocol DaemonService
  (start [this])
  (stop [this]))

(defrecord UmbraDaemon [config socket]
  DaemonService
  (start [this]
    (println (str "Starting on " (:host config) ":" (:port config))))
  (stop [this]
    (println "Stopping daemon")))

(defn create-daemon [host port]
  (->UmbraDaemon {:host host :port port} nil))

(defn handle-request [path]
  (case path
    "/health" {:status 200 :body "OK"}
    {:status 404 :body "Not Found"}))

(defmacro with-timeout [ms & body]
  `(async/timeout ~ms ~@body))

(defmulti dispatch-event :type)

(defmethod dispatch-event :start [event]
  (println "Starting daemon" (:payload event)))

(defmethod dispatch-event :stop [event]
  (println "Stopping daemon"))
