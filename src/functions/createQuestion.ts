import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db"; // Adjust path as needed
import { createErrorResponse } from "../utils";
// Interfaces for request payloads
interface CreateQuestionRequest {
  username: string;
  form_type: string;
  form_language: string;
  question: QuestionData;
  options?: OptionData[];
}

interface QuestionData {
  description: string;
  question_type: string;
  required?: boolean;
  question_text: string;
  image_urls?: string[];  // Array of image URLs for radio_image type
}

interface OptionData {
  description: string;
  language: string;
}

export async function createQuestion(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Parse input JSON
  const { username, form_type, form_language, question, options } = await req.json() as CreateQuestionRequest;

  // Validate required input
  if (!username || !form_type || !form_language || !question) {
    return createErrorResponse(400, "username, form_type, form_language and question are required")
  }
  
  const { description, question_type, required = false, question_text, image_urls } = question;
  if (!description || !question_type || !question_text) {
    return createErrorResponse(400, "question must include description, question_type and question_text");
  }

  // Validate image_urls if question type is radio_image
  if (question_type === 'radio_image' && (!image_urls || !Array.isArray(image_urls) || image_urls.length === 0)) {
    return createErrorResponse(400, "radio_image questions must include image_urls array");
  }

  try {
    const pool = await getPool();

    // Start a transaction to ensure atomicity
    const transaction = pool.transaction();
    await transaction.begin();

    // Use a request bound to the transaction
    const request = transaction.request();

    // 1. Lookup the user by username (assuming username is the email)
    const userQuery = "SELECT id FROM users WHERE email = @username";
    const userResult = await request.input("username", username).query(userQuery);
    if (userResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(404, "User not found");
    }
    const userId = userResult.recordset[0].id;

    // 2. Find the form for that user based on form type (category)
    const formQuery = "SELECT id FROM forms WHERE user_id = @userId AND category = @form_type";
    const formResult = await request.input("userId", userId)
                                   .input("form_type", form_type)
                                   .query(formQuery);
    if (formResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(404, "Form not found for given user and form type");
    }
    const formId = formResult.recordset[0].id;

    // 3. Get the form translation based on the form id and language
    const formTransQuery = "SELECT id FROM form_translations WHERE form_id = @formId AND language = @form_language";
    const formTransResult = await request.input("formId", formId)
                                        .input("form_language", form_language)
                                        .query(formTransQuery);
    if (formTransResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(404, "Form translation not found for the provided language");
    }
    const formTranslationId = formTransResult.recordset[0].id;

    // 4. Insert the new question into the questions table
    // First, get the current max position for questions in this form
    const questionPositionQuery = `
      SELECT ISNULL(MAX(q.position), 0) AS maxPos
      FROM questions q
      JOIN question_translations qt ON q.id = qt.question_id
      JOIN form_question_translations fqt ON qt.id = fqt.question_translation_id
      WHERE fqt.form_translation_id = @formTranslationId
    `;
    const questionPosRequest = transaction.request();
    const questionPosResult = await questionPosRequest
      .input("formTranslationId", formTranslationId)
      .query(questionPositionQuery);
    const maxQuestionPosition = questionPosResult.recordset[0].maxPos;
    const questionPosition = maxQuestionPosition + 1;

    const insertQuestionQuery = `
      INSERT INTO questions (description, question_type, required, position, image_urls)
      OUTPUT INSERTED.id
      VALUES (@description, @question_type, @required, @position, @image_urls)
    `;
    const questionRequest = transaction.request();
    const questionResult = await questionRequest
      .input("description", description)
      .input("question_type", question_type)
      .input("required", required)
      .input("position", questionPosition)
      .input("image_urls", image_urls ? JSON.stringify(image_urls) : null)
      .query(insertQuestionQuery);
    if (questionResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(500, "Failed to insert question");
    }
    const questionId = questionResult.recordset[0].id;

    // 5. Insert the question translation
    const insertQuestionTransQuery = `
      INSERT INTO question_translations (question_id, language, question_text)
      OUTPUT INSERTED.id
      VALUES (@question_id, @language, @question_text)
    `;
    const questionTransRequest = transaction.request();
    const questionTransResult = await questionTransRequest
      .input("question_id", questionId)
      .input("language", form_language) // Using form language for the question translation
      .input("question_text", question_text)
      .query(insertQuestionTransQuery);
    if (questionTransResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(500, "Failed to insert question translation");
    }
    const questionTranslationId = questionTransResult.recordset[0].id;

    // 6. Process optional options if provided
    if (options && Array.isArray(options)) {
      // Get the current max position for options of this question
      const optionPositionQuery = `
        SELECT ISNULL(MAX(position), 0) AS maxPos
        FROM question_options
        WHERE question_id = @question_id
      `;
      const optionPosRequest = transaction.request();
      const optionPosResult = await optionPosRequest
        .input("question_id", questionId)
        .query(optionPositionQuery);
      let currentPosition = optionPosResult.recordset[0].maxPos;

      for (const opt of options) {
        const { description: optionDescription, language: optionLanguage } = opt;
        if (!optionDescription || !optionLanguage) {
          await transaction.rollback();
          return createErrorResponse(400, "Each option must include description and language");
        }
        
        // Increment position for each option
        currentPosition++;

        // Insert into question_options to get an option id
        const insertOptionQuery = `
          INSERT INTO question_options (question_id, position)
          OUTPUT INSERTED.id
          VALUES (@question_id, @position)
        `;
        const optionRequest = transaction.request();
        const optionResult = await optionRequest
          .input("question_id", questionId)
          .input("position", currentPosition)
          .query(insertOptionQuery);
        if (optionResult.recordset.length === 0) {
          await transaction.rollback();
          return createErrorResponse(500, "Failed to insert question option");
        }
        const optionId = optionResult.recordset[0].id;

        // Insert into question_option_translations
        const insertOptionTransQuery = `
          INSERT INTO question_option_translations (option_id, language, option_text)
          VALUES (@option_id, @language, @option_text)
        `;
        const optionTransRequest = transaction.request();
        await optionTransRequest
          .input("option_id", optionId)
          .input("language", optionLanguage)
          .input("option_text", optionDescription)
          .query(insertOptionTransQuery);
      }
    }

    const insertFormQuestionTransQuery = `
      INSERT INTO form_question_translations (form_translation_id, question_translation_id)
      VALUES (@form_translation_id, @question_translation_id)
    `;
    const formQuestionTransRequest = transaction.request();
    await formQuestionTransRequest
      .input("form_translation_id", formTranslationId)
      .input("question_translation_id", questionTranslationId)
      .query(insertFormQuestionTransQuery);

    // Commit the transaction if everything succeeded
    await transaction.commit();

    return {
      status: 201,
      jsonBody : {
        body: questionId 
      }
    };

  } catch (error) {
    context.log("Error inserting question:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
};

app.http('createQuestion', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: createQuestion,
});
