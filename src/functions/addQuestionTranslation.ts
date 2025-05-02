import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db";
import { createErrorResponse } from "../utils";

// Interfaces for request payloads
interface AddQuestionTranslationRequest {
  question_id: string;
  language: string;
  question_text: string;
  form_type: string;
  options?: OptionTranslation[];
}

interface OptionTranslation {
  option_id: string;
  option_text: string;
}

export async function addQuestionTranslation(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Parse input JSON
  const { question_id, language, question_text, form_type, options } = await req.json() as AddQuestionTranslationRequest;

  // Validate required input
  if (!question_id || !language || !question_text || !form_type) {
    return createErrorResponse(400, "question_id, language, question_text, and form_type are required");
  }

  // Validate language
  if (language !== 'en' && language !== 'es') {
    return createErrorResponse(400, "language must be either 'en' or 'es'");
  }

  // Validate form type
  if (form_type !== 'custom' && form_type !== 'flash' && form_type !== 'touchup') {
    return createErrorResponse(400, "form_type must be either 'custom', 'flash', or 'touchup'");
  }

  try {
    const pool = await getPool();

    // Start a transaction to ensure atomicity
    const transaction = pool.transaction();
    await transaction.begin();

    // Use a request bound to the transaction
    const request = transaction.request();

    // 1. Verify the question exists
    const questionQuery = `
      SELECT id FROM questions WHERE id = @questionId
    `;
    const questionResult = await request
      .input("questionId", question_id)
      .query(questionQuery);
    
    if (questionResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(404, "Question not found");
    }

    // 2. Check if a translation for this language already exists
    const existingTranslationQuery = `
      SELECT id FROM question_translations 
      WHERE question_id = @transQuestionId AND language = @transLanguage
    `;
    const existingTranslationResult = await request
      .input("transQuestionId", question_id)
      .input("transLanguage", language)
      .query(existingTranslationQuery);
    
    if (existingTranslationResult.recordset.length > 0) {
      await transaction.rollback();
      return createErrorResponse(409, "A translation for this language already exists");
    }

    // 3. Insert the question translation
    const insertQuestionTransQuery = `
      INSERT INTO question_translations (question_id, language, question_text)
      OUTPUT INSERTED.id
      VALUES (@insertQuestionId, @insertLanguage, @insertQuestionText)
    `;
    const questionTransRequest = transaction.request();
    const questionTransResult = await questionTransRequest
      .input("insertQuestionId", question_id)
      .input("insertLanguage", language)
      .input("insertQuestionText", question_text)
      .query(insertQuestionTransQuery);
    
    if (questionTransResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(500, "Failed to insert question translation");
    }
    const questionTranslationId = questionTransResult.recordset[0].id;

    // 4. Process option translations if provided
    if (options && Array.isArray(options)) {
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const { option_id, option_text } = option;
        
        if (!option_id || !option_text) {
          await transaction.rollback();
          return createErrorResponse(400, "Each option translation must include option_id and option_text");
        }
        
        // Verify the option belongs to the question
        const optionQuery = `
          SELECT id FROM question_options 
          WHERE id = @optionId${i} AND question_id = @optionQuestionId${i}
        `;
        const optionResult = await request
          .input(`optionId${i}`, option_id)
          .input(`optionQuestionId${i}`, question_id)
          .query(optionQuery);
        
        if (optionResult.recordset.length === 0) {
          await transaction.rollback();
          return createErrorResponse(404, `Option with ID ${option_id} not found or does not belong to the question`);
        }
        
        // Check if a translation for this option and language already exists
        const existingOptionTransQuery = `
          SELECT id FROM question_option_translations 
          WHERE option_id = @existingOptionId${i} AND language = @existingOptionLanguage${i}
        `;
        const existingOptionTransResult = await request
          .input(`existingOptionId${i}`, option_id)
          .input(`existingOptionLanguage${i}`, language)
          .query(existingOptionTransQuery);
        
        if (existingOptionTransResult.recordset.length > 0) {
          await transaction.rollback();
          return createErrorResponse(409, `A translation for option ${option_id} in language ${language} already exists`);
        }
        
        // Insert the option translation
        const insertOptionTransQuery = `
          INSERT INTO question_option_translations (option_id, language, option_text)
          VALUES (@insertOptionId${i}, @insertOptionLanguage${i}, @insertOptionText${i})
        `;
        const optionTransRequest = transaction.request();
        await optionTransRequest
          .input(`insertOptionId${i}`, option_id)
          .input(`insertOptionLanguage${i}`, language)
          .input(`insertOptionText${i}`, option_text)
          .query(insertOptionTransQuery);
      }
    }

    // 5. Find the form translation ID to link the question translation
    const formTransQuery = `
      SELECT ft.id
      FROM form_translations ft
      JOIN forms f ON ft.form_id = f.id
      WHERE f.category = @formType AND ft.language = @formLanguage
    `;
    const formTransResult = await request
      .input("formType", form_type)
      .input("formLanguage", language)
      .query(formTransQuery);
    
    // If a form translation exists for this language, link the question translation
    if (formTransResult.recordset.length > 0) {
      const formTranslationId = formTransResult.recordset[0].id;
      
      const insertFormQuestionTransQuery = `
        INSERT INTO form_question_translations (form_translation_id, question_translation_id)
        VALUES (@insertFormTransId, @insertQuestionTransId)
      `;
      const formQuestionTransRequest = transaction.request();
      await formQuestionTransRequest
        .input("insertFormTransId", formTranslationId)
        .input("insertQuestionTransId", questionTranslationId)
        .query(insertFormQuestionTransQuery);
    }

    // Commit the transaction if everything succeeded
    await transaction.commit();

    return {
      status: 201,
      jsonBody: {
        message: "Question translation added successfully",
        question_translation_id: questionTranslationId
      }
    };

  } catch (error) {
    context.log("Error adding question translation:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
}

app.http('addQuestionTranslation', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: addQuestionTranslation,
}); 