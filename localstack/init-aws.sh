#!/bin/bash
set -e

echo "Creating SQS queues..."

awslocal sqs create-queue --queue-name billing-inbound
awslocal sqs create-queue --queue-name billing-outbound
awslocal sqs create-queue --queue-name billing-scheduler

echo "SQS queues created successfully:"
awslocal sqs list-queues
