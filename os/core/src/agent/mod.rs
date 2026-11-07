//! Agents at work in the person's repos: what their harnesses report and the sessions read from it (activity.rs),
//! the Agent's own hands' rules, Pi's (hands.rs), and what an agent does for the person, and when (agent/tasks.rs).

// No unsafe code in this layer.
#![forbid(unsafe_code)]

pub mod activity;
pub mod hands;
pub mod tasks;
