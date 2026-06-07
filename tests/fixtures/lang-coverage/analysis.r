library(jsonlite)
library(dplyr)
require(ggplot2)

# Data loading and analysis utilities

load_session_data <- function(path) {
  data <- fromJSON(path)
  return(data)
}

compute_stats <- function(data) {
  summary_stats <- data %>%
    group_by(session_id) %>%
    summarise(
      total_tokens = sum(tokens),
      message_count = n()
    )
  return(summary_stats)
}

plot_usage <- function(stats) {
  ggplot(stats, aes(x = session_id, y = total_tokens)) +
    geom_bar(stat = "identity") +
    labs(title = "Token Usage per Session")
}

DaemonMonitor <- setRefClass("DaemonMonitor",
  fields = list(
    host = "character",
    port = "numeric"
  ),
  methods = list(
    initialize = function(h = "127.0.0.1", p = 9876) {
      host <<- h
      port <<- p
    },
    ping = function() {
      cat("Pinging", host, ":", port, "\n")
    }
  )
)

config_defaults <- list(
  host = "127.0.0.1",
  port = 9876,
  max_sessions = 100
)

DEFAULT_PORT <- 9876
