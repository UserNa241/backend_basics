// src/app-validation.mjs
//
// S6 Build 2 — Input validation for the application service.
//
// This module provides the validation layer from S6 Lesson 2: the
// application checks the input BEFORE it reaches the database.
// Validation is the application's own first layer of defense — it
// catches the obvious problems early, with clear messages, and
// protects the database from being asked to process invalid data.
//
// These are small, focused helpers. Each one does one thing:
// check one kind of input rule and throw a ValidationError if the
// rule is broken.

/**
 * A domain-level error thrown when input validation fails.
 *
 * This is NOT an HTTP error. It is a domain decision: "the input
 * is invalid, and here is which field is wrong and why." Build 3
 * will handle mapping these errors to HTTP responses.
 *
 * @property {string} field - The name of the field that failed validation.
 * @property {string} message - A human-readable explanation of the failure.
 */
export class ValidationError extends Error {
    constructor(field, message) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

/**
 * Checks that all required fields are present and non-empty strings.
 *
 * This is the first validation helper. It takes an input object and
 * an array of field names. For each field name, it checks:
 *   1. The field exists on the input object.
 *   2. The field's value is a string.
 *   3. The string is not empty (after trimming whitespace).
 *
 * If any field fails, it throws a ValidationError naming that field.
 * If all fields pass, it returns nothing (the function just confirms
 * the input is valid by not throwing).
 *
 * @param {object} input - The input object to validate.
 * @param {string[]} fields - The names of the required fields.
 * @throws {ValidationError} If any required field is missing or empty.
 */
export function validateRequired(input, fields) {
    for (const field of fields) {
        const value = input[field];

        if (value === undefined || value === null) {
            throw new ValidationError(
                field,
                `Field "${field}" is required.`,
            );
        }

        if (typeof value !== 'string') {
            throw new ValidationError(
                field,
                `Field "${field}" must be a string.`,
            );
        }

        if (value.trim() === '') {
            throw new ValidationError(
                field,
                `Field "${field}" must not be empty.`,
            );
        }
    }
}

/**
 * Checks that an email address looks like an email.
 *
 * This goes beyond validateRequired — which only checks that the
 * value is a non-empty string. An email needs an "@" symbol and a
 * domain part after it. This helper checks for that minimum shape.
 *
 * It is deliberately simple: it catches the obvious mistakes
 * ("not-an-email", "user@", "@example.com") without trying to be a
 * full RFC email validator. The database's unique constraint on
 * email is the second layer of defense for anything this misses.
 *
 * @param {string} email - The email value to validate.
 * @throws {ValidationError} If the email does not contain "@"
 *   or has no domain part after "@".
 */
export function validateEmail (email) {
    //Must contain exactly the shape: something @ something
    if (!email.includes('@')) {
        throw new ValidationError('email', 'Field "email" must contain "@"');
    }

    //Split on "@" - the part after @ is domain
    const parts = email.split('@');

    //There must be exactly 2 parts
    if (parts.length !== 2) {
        throw new ValidationError('email', 'Field "email" must contain exactly one "@"');
    }

    //The domain part (after @) must not be empty
    if (parts[1] === '') {
        throw new ValidationError('email', 'Field "email" must have a domain after "@"');
    }
}

/**
 * Checks that a task status is one of the allowed values.
 *
 * The allowed statuses are the same three values enforced by the
 * database's CHECK constraint in the tasks table:
 * 'todo', 'in_progress', or 'done'.
 *
 * This is the application's check — it catches invalid statuses
 * before the database does, with a clearer message.
 *
 * @param {string} status - The status value to validate.
 * @throws {ValidationError} If the status is not one of the allowed values.
 */
export function validateStatus(status) {
    const allowedStatus = ['todo', 'in_progress', 'done'];

    if (!allowedStatus.includes(status)) {
        throw new ValidationError('status', `Field "status" must be one of: ${allowedStatus.join(', ')}.`);
    }
}
